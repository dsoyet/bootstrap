// ==UserScript==
// @name         Player
// @namespace    https://greasyfork.org/
// @version      5.1
// @description  115 Cloud：A-Frame 180° VR Player
// @match        https://115.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      webapi.115.com
// @connect      cdn.jsdelivr.net
// @connect      aframe.io
// @connect      *
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ── 播放列表存储 ──
    const PL_KEY = 'vr_playlist';
    function getPL() {
        try { return JSON.parse(GM_getValue(PL_KEY, '[]')); } catch(e) { return []; }
    }
    function savePL(list) { GM_setValue(PL_KEY, JSON.stringify(list)); }
    function addToPL(pickcode, name, cid) {
        var list = getPL();
        list = list.filter(function(x) { return x.pickcode !== pickcode; });
        list.unshift({ pickcode: pickcode, name: name, cid: cid || '', ts: Date.now() });
        if (list.length > 200) list.length = 200;
        savePL(list);
        showToast('📋 已加入播放列表 (' + list.length + ')');
    }
    function showToast(msg) {
        var t = document.createElement('div');
        t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:99999;background:#333;color:#fff;padding:8px 20px;border-radius:6px;font-size:14px;pointer-events:none';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(function() { t.remove(); }, 2000);
    }

    // 导航播放列表（队列化，一次只允许一个切换在飞）
    var navPending = null, navBusy = false;
    function navToPL(targetIdx) {
        if (navBusy) { navPending = targetIdx; return; }
        doNav(targetIdx);
    }
    function doNav(idx) {
        var pl = getPL();
        if (idx < 0 || idx >= pl.length) { navBusy = false; pumpNav(); return; }
        navBusy = true;
        var tgt = pl[idx];
        history.pushState(null, '', 'https://115.com/web/lixian/?pickcode=' + tgt.pickcode);
        loadVideo(tgt.pickcode, tgt.name, tgt.cid, function() {
            navBusy = false;
            pumpNav();
        });
    }
    function pumpNav() {
        if (navPending !== null) {
            var next = navPending;
            navPending = null;
            doNav(next);
        }
    }

    // ── 全局状态 ──
    var curPid = null, curFileId = null, curParentId = null, autoNext = false, hls = null, v = null;
    var isVR = true, vSphere = null, vFlat = null, cam = null;

    if (location.pathname === '/web/lixian/' && location.search.includes('pickcode=')) {
        const pid = new URL(location.href).searchParams.get('pickcode');
        if (!pid) return;
        initScene().then(function() { loadVideo(pid, null, null, null); });
    }

    function loadSubIfReady(cid, name, parentCid) {
        if (cid) {
            console.log('[Player] 尝试加载字幕, name=' + name + ', cid=' + cid + ', parent=' + (parentCid || ''));
            if (window._loadSub) { window._loadSub(name, cid, parentCid); }
            else { console.log('[Player] _loadSub 未就绪'); }
        } else {
            console.log('[Player] 无 cid，跳过字幕');
        }
    }

    // 删除当前播放的视频文件
    function deleteCurrentVideo() {
        if (!curPid || !curFileId) { showToast('⚠ 无法获取文件信息'); return; }

        console.log('[Player] 删除文件 file_id=' + curFileId + ' pid=' + curParentId);
        showToast('🗑 正在删除...');
        GM_xmlhttpRequest({
            method: 'POST',
            url: 'https://webapi.115.com/rb/delete',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            data: 'fid[0]=' + curFileId + '&pid=' + (curParentId || '0'),
            timeout: 10000,
            onload: function(r) {
                try {
                    var d = JSON.parse(r.responseText);
                    console.log('[Player] 删除响应:', r.responseText.substring(0, 300));
                    if (d.state) {
                        showToast('✅ 已删除');
                        // 删除前记录当前位置
                        var list = getPL(), delIdx = -1;
                        for (var i = 0; i < list.length; i++) {
                            if (list[i].pickcode === curPid) { delIdx = i; break; }
                        }
                        // 从播放列表移除
                        list = list.filter(function(x) { return x.pickcode !== curPid; });
                        savePL(list);
                        if (window._renderPL) window._renderPL();
                        // 跳到下一个（同一索引位置）
                        if (delIdx >= 0 && delIdx < list.length) {
                            navToPL(delIdx);
                        } else if (list.length > 0) {
                            navToPL(list.length - 1);
                        } else {
                            showToast('📭 播放列表已空');
                        }
                    } else {
                        showToast('❌ 删除失败: ' + (d.msg || d.error || ''));
                    }
                } catch(e) {
                    showToast('❌ 删除失败');
                }
            },
            onerror: function() { showToast('❌ 网络错误'); }
        });
    }

    function loadVideo(pid, fallbackName, cid, onReady) {
        var url = 'https://webapi.115.com/files/video?pickcode=' + pid;
        if (cid) url += '&cid=' + cid;
        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            onload: function(res) {
                try {
                    var d = JSON.parse(res.responseText);
                    console.log('[Player] API keys:', Object.keys(d).join(', '));
                    console.log('[Player] subtitle_info:', JSON.stringify(d.subtitle_info));
                    // 115 新版 API 可能不再直接返回 video_url，需要二次请求
                    if (!d.state) {
                        console.log('[Player] loadVideo state=false', pid, res.responseText.substring(0, 300));
                        if (d.code === 911) {
                            var capUrl = (d.data && d.data.url) ? d.data.url.replace(/^http:/, 'https:') : '';
                            console.log('[Player] 911 验证URL:', capUrl);
                            if (capUrl) {
                                var w = 500, h = 420;
                                var pop = window.open(capUrl, '115_captcha', 'width=' + w + ',height=' + h + ',left=' + ((screen.width-w)/2) + ',top=' + ((screen.height-h)/2));
                                if (!pop) GM_openInTab(capUrl, true);
                            }
                            showToast('⚠ 115验证：完成弹窗验证后，点击右侧列表重试');
                            if (onReady) onReady();
                            return;
                        }
                        showToast('❌ 获取视频失败 (' + (d.code || d.errorno || d.state || '') + ')');
                        if (onReady) onReady();
                        return;
                    }
                    var name = d.file_name || fallbackName || pid;
                    var parentCid = d.parent_id || '';
                    var fileId = d.file_id || '';
                    curFileId = fileId;
                    curParentId = parentCid;
                    // 字幕扫描和视频加载并行
                    if (cid || parentCid) {
                        loadSubIfReady(cid || parentCid, name, parentCid);
                    }
                    // 新版 API: video_url 直接播放, queue_url 需轮询转码
                    var videoUrl = d.video_url;
                    var queueUrl = d.queue_url;
                    if (videoUrl) {
                        switchVideo(videoUrl.replace(/^http(s)?/, 'https'), name, pid, onReady);
                        return;
                    }
                    if (queueUrl) {
                        // 转码中，自动跳到下一个
                        console.log('[Player] 视频转码中，跳过...');
                        showToast('⏭ 转码中，自动跳过');
                        if (onReady) onReady();
                        // 跳到下一个视频
                        var pl = getPL(), idx = -1;
                        for (var i = 0; i < pl.length; i++) {
                            if (pl[i].pickcode === pid) { idx = i; break; }
                        }
                        if (idx >= 0 && idx < pl.length - 1) { navToPL(idx + 1); }
                        else if (pl.length > 0) { navToPL(0); }
                        return;
                    }
                    // 完全没有播放地址
                    console.log('[Player] 无播放地址，尝试其他方式...');
                    fetchVideoUrl(pid, fileId, name, onReady, null, null);
                } catch (e) {
                    console.log('[Player] loadVideo 解析异常', e);
                    showToast('❌ 数据解析失败');
                    if (onReady) onReady();
                }
            },
            onerror: function(e) {
                console.log('[Player] loadVideo 网络错误', pid, e);
                showToast('❌ 网络错误，3秒后重试...');
                setTimeout(function() { loadVideo(pid, fallbackName, cid, onReady); }, 3000);
            },
            ontimeout: function() {
                console.log('[Player] loadVideo 超时', pid);
                showToast('❌ 请求超时，3秒后重试...');
                setTimeout(function() { loadVideo(pid, fallbackName, cid, onReady); }, 3000);
            },
            timeout: 15000
        });
    }

    // 新版 115 API: 二次请求获取真实播放地址
    function fetchVideoUrl(pid, fileId, name, onReady, queueUrl, originUrl) {
        var reqHeaders = { 'Referer': 'https://115.com/', 'Origin': 'https://115.com' };

        // queue_url: 转码排队，轮询获取真实 m3u8
        if (queueUrl) {
            console.log('[Player] 转码排队中，轮询 queue_url...');
            showToast('⏳ 转码中，请稍候...');
            pollTranscode(queueUrl, 0, name, pid, onReady);
            return;
        }

        // 兜底: 重新请求 /files/video
        var url1 = 'https://webapi.115.com/files/video?pickcode=' + pid;
        if (fileId) url1 += '&file_id=' + fileId;
        console.log('[Player] fetchVideoUrl 兜底 GET /files/video');
        GM_xmlhttpRequest({
            method: 'GET', url: url1, headers: reqHeaders, timeout: 15000,
            onload: function(r) {
                try {
                    var d = JSON.parse(r.responseText);
                    if (d.video_url) { switchVideo(d.video_url.replace(/^http(s)?/, 'https'), name, pid, onReady); return; }
                    if (d.queue_url) { pollTranscode(d.queue_url, 0, name, pid, onReady); return; }
                } catch(e) {}
                showToast('❌ 无法获取播放地址');
                if (onReady) onReady();
            },
            onerror: function() { showToast('❌ 网络错误'); if (onReady) onReady(); }
        });
    }

    // 轮询 115 转码队列, 最多等 60 秒
    function pollTranscode(queueUrl, count, name, pid, onReady) {
        if (count > 40) {
            console.log('[Player] 转码超时');
            showToast('❌ 转码超时，请刷新重试');
            if (onReady) onReady();
            return;
        }
        GM_xmlhttpRequest({
            method: 'GET',
            url: queueUrl.replace(/^http(s)?/, 'https'),
            timeout: 10000,
            onload: function(r) {
                try {
                    var d = JSON.parse(r.responseText);
                    console.log('[Player] 转码轮询 #' + count + ' keys:', Object.keys(d).join(', '));
                    // 转码完成，尝试提取 video_url
                    var realUrl = d.video_url || d.url || d.file_url ||
                        (d.data && (d.data.video_url || d.data.url || d.data.file_url));
                    if (realUrl) {
                        console.log('[Player] 转码完成，播放:', realUrl.substring(0, 100));
                        switchVideo(realUrl.replace(/^http(s)?/, 'https'), name, pid, onReady);
                        return;
                    }
                    // 检查是否完成但 URL 字段名不同
                    if (d.state === true || (d.data && d.data.state === true)) {
                        var full = JSON.stringify(d);
                        console.log('[Player] 转码完成但未找到URL, full:', full.substring(0, 500));
                        // 尝试从完整响应中提取
                        var m = full.match(/"video_url"\s*:\s*"([^"]+)"/) || full.match(/"url"\s*:\s*"([^"]+)"/);
                        if (m) {
                            switchVideo(m[1].replace(/^http(s)?/, 'https'), name, pid, onReady);
                            return;
                        }
                    }
                } catch(e) {}
                // 继续轮询
                setTimeout(function() { pollTranscode(queueUrl, count + 1, name, pid, onReady); }, 1500);
            },
            onerror: function() {
                setTimeout(function() { pollTranscode(queueUrl, count + 1, name, pid, onReady); }, 2000);
            }
        });
    }

    // ── 全局状态 ──
    var curPid = null, autoNext = false, hls = null, v = null;
    var isVR = true, vSphere = null, vFlat = null, cam = null;

    async function initScene(onReady) {
            document.head.innerHTML = '<meta charset="utf-8"><title>VR Player</title>';
            document.body.style.cssText = 'margin:0;padding:0;background:#000;overflow:hidden';
            document.body.innerHTML =
                `<div id="scene-box" style="width:100vw;height:100vh">
                    <a-scene embedded style="width:100%;height:100%" vr-mode-ui="enabled:true">
                        <a-assets><video id="vr-src" crossorigin="anonymous" playsinline autoplay muted loop></video></a-assets>
                        <a-sky id="vr-sphere" src="#vr-src" phi-start="180" phi-length="180" radius="5000"></a-sky>
                        <a-video id="vr-flat" src="#vr-src" width="23" height="12.9375" position="0 0 -7.7" visible="false"></a-video>
                        <a-camera id="cam" position="0 0 0" wasd-controls="acceleration:50" look-controls="reverseMouseDrag:true"></a-camera>
                    </a-scene>
                </div>` +
                '<div id="sub-overlay" style="position:fixed;bottom:30px;left:50%;transform:translateX(-50%);z-index:99999999;pointer-events:none;display:none;text-align:center;max-width:90%"><span style="color:#fff;font-size:26px;font-weight:bold;display:inline-block;line-height:1.5;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000,0 0 8px #000,0 0 16px #000"></span></div>' +
                '<div id="progress-bar" style="position:fixed;bottom:20px;left:10%;width:80%;height:4px;background:rgba(255,255,255,0.2);border-radius:2px;z-index:10000;display:none"><div id="progress-fill" style="height:100%;background:#1e90ff;border-radius:2px;width:0%"></div></div>' +
                '<div id="msg" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#aaa;font-size:16px;z-index:10">⏳ 加载中...</div>';

            await loadJs('https://cdn.jsdelivr.net/npm/hls.js@1.6.16/dist/hls.min.js');
            await loadJs('https://aframe.io/releases/1.6.0/aframe.min.js');
            console.log('[115Player] 就绪');

            // Quest 移动端优化
            if (/Oculus|Quest/i.test(navigator.userAgent)) {
                var scene = document.querySelector('a-scene');
                if (scene) {
                    scene.setAttribute('renderer', 'antialias:false;sortObjects:true;physicallyCorrectLights:false;maxCanvasWidth:2048;maxCanvasHeight:2048');
                }
            }

            // 180° SBS UV：取左眼画面
            (function fixUV() {
                const sphere = document.getElementById('vr-sphere');
                const mesh = sphere.getObject3D('mesh');
                if (!mesh) { sphere.addEventListener('loaded', fixUV); return; }
                const uv = mesh.geometry.attributes.uv;
                if (!uv) return;
                for (let i = 0; i < uv.count; i++) {
                    uv.setX(i, uv.getX(i) * 0.5);
                }
                uv.needsUpdate = true;
            })();

            v = document.getElementById('vr-src');
            vSphere = document.getElementById('vr-sphere');
            vFlat = document.getElementById('vr-flat');
            cam = document.getElementById('cam');
            autoNext = GM_getValue('vr_auto_next', false);

            function switchMode(vr) {
                isVR = vr;
                vSphere.setAttribute('visible', vr);
                vFlat.setAttribute('visible', !vr);
                cam.setAttribute('wasd-controls', vr ? 'acceleration:50' : 'enabled:false');
            }

            // HLS 跳转：队列化，一次只允许一个 seek 飞行中
            var pendingSeek = null;
            v.addEventListener('seeked', function() {
                if (pendingSeek !== null) {
                    var t = pendingSeek;
                    pendingSeek = null;
                    v.currentTime = t;
                }
            });
            function hlsSeek(t) {
                if (!hls) return;
                if (v.seeking) {
                    pendingSeek = t;
                } else {
                    v.currentTime = t;
                }
            }

            // 进度条
            const progBar = document.getElementById('progress-bar');
            const progFill = document.getElementById('progress-fill');
            let progTimer = 0;
            function showProgress() {
                if (!v.duration) return;
                progFill.style.width = (v.currentTime / v.duration * 100) + '%';
                progBar.style.display = 'block';
                clearTimeout(progTimer);
                progTimer = setTimeout(() => { progBar.style.display = 'none'; }, 2000);
            }

            // 键盘：←→15s 空格暂停 S统计，→同时取消静音
            window._115Key = function (e) {
                // WebHID 已处理的媒体键，抑制 keydown 重复触发
                if (hidSuppressKey && (e.key === 'MediaTrackNext' || e.key === 'MediaTrackPrevious' ||
                    e.key === 'Next' || e.key === 'NEXT' || e.key === 'Prev' || e.key === 'PREV' ||
                    e.key === 'MediaPlayPause')) {
                    return;
                }
                if (!v.duration) return;
                if (e.key === 'ArrowLeft' || e.key === 'MediaTrackPrevious' || e.key === 'Prev' || e.key === 'PREV' || e.key === 'PageUp') {
                    hlsSeek(Math.max(0, v.currentTime - 60)); showProgress(); e.preventDefault();
                }
                else if (e.key === 'ArrowRight' || e.key === 'MediaTrackNext' || e.key === 'Next' || e.key === 'NEXT' || e.key === 'PageDown') {
                    hlsSeek(Math.min(v.duration, v.currentTime + 60)); v.muted = false; showProgress(); e.preventDefault();
                }
                else if (e.key === 'ArrowUp' || e.key === 'AudioVolumeDown' || e.key === 'VolumeDown' || e.keyCode === 174) {
                    var pl = getPL(), idx = -1;
                    for (var i = 0; i < pl.length; i++) { if (pl[i].pickcode === curPid) { idx = i; break; } }
                    if (idx > 0) navToPL(idx - 1);
                    e.preventDefault();
                }
                else if (e.key === 'ArrowDown' || e.key === 'AudioVolumeUp' || e.key === 'VolumeUp' || e.keyCode === 175) {
                    var pl = getPL(), idx = -1;
                    for (var i = 0; i < pl.length; i++) { if (pl[i].pickcode === curPid) { idx = i; break; } }
                    if (idx >= 0 && idx < pl.length - 1) navToPL(idx + 1);
                    e.preventDefault();
                }
                else if (e.key === 'Enter') {
                    deleteCurrentVideo(); e.preventDefault();
                }
                else if (e.key === ' ' || e.key === 'MediaPlayPause') { v.paused ? v.play() : v.pause(); e.preventDefault(); }
                else if (e.key === 'v' && !e.ctrlKey && !e.altKey) { switchMode(!isVR); }
                else if (e.key === 'a' && !e.ctrlKey && !e.altKey) {
                    autoNext = !autoNext;
                    GM_setValue('vr_auto_next', autoNext);
                    showToast(autoNext ? '▶ 自动连播: ON' : '▶ 自动连播: OFF');
                }
                else if (e.key === 's' && !e.ctrlKey && !e.altKey) {
                    const st = document.getElementById('stats');
                    st.style.display = st.style.display === 'block' ? 'none' : 'block';
                }
                else if (e.key === 'c' && !e.ctrlKey && !e.altKey) {
                    if (subData && subData.length > 0) {
                        subVisible = !subVisible;
                        subEl.style.display = subVisible ? 'block' : 'none';
                        showToast(subVisible ? '💬 字幕: ON' : '💬 字幕: OFF');
                    }
                }
                else if (e.key === 'Delete' && !e.ctrlKey && !e.altKey) {
                    deleteCurrentVideo(); e.preventDefault();
                }
            };
            window.addEventListener('keydown', window._115Key);

            // Gamepad API: 手柄/VR遥控器按键（上下键不触发浏览器事件）
            var gpState = {}, gpFirstLog = true;
            function pollGamepad() {
                var gps = navigator.getGamepads ? navigator.getGamepads() : [];
                for (var gi = 0; gi < gps.length; gi++) {
                    var gp = gps[gi];
                    if (!gp) continue;
                    // 首次检测到手柄，打印所有信息
                    if (gpFirstLog) {
                        console.log('[Player] 检测到手柄 id=' + gp.id + ' buttons=' + gp.buttons.length + ' axes=' + gp.axes.length);
                        for (var b = 0; b < gp.buttons.length; b++) {
                            if (gp.buttons[b].pressed) console.log('[Player] 手柄按钮 #' + b + ' 按下 value=' + gp.buttons[b].value);
                        }
                        gpFirstLog = false;
                    }
                    // 检测新按下的按钮（带防抖）
                    for (var b = 0; b < gp.buttons.length; b++) {
                        var key = gi + '_b' + b;
                        if (gp.buttons[b].pressed && !gpState[key]) {
                            console.log('[Player] 手柄按钮 #' + b + ' value=' + gp.buttons[b].value.toFixed(2));
                            if (v.duration) {
                                // 上下键映射：待根据日志确定按钮编号
                                // 暂时打印，不执行操作
                            }
                        }
                        gpState[key] = gp.buttons[b].pressed;
                    }
                }
                requestAnimationFrame(pollGamepad);
            }
            pollGamepad();
            console.log('[Player] Gamepad 轮询已启动，按手柄上下键查看按钮编号');

            // ── WebHID: 蓝牙遥控器 Consumer Control ──
            // FORWARD/NEXT 和 REWIND/PREV 在 keydown 层合并，需 WebHID 区分
            var hidDevice = null;
            var hidSuppressKey = false; // WebHID 处理过的键，抑制 keydown 重复

            function handleHIDReport(data) {
                // Consumer Control 报告: [ReportID, Usage_LO, Usage_HI, ...]
                var usage = data[1] | (data[2] << 8);
                console.log('[Player] WebHID usage=0x' + usage.toString(16).toUpperCase().padStart(4, '0'));
                hidSuppressKey = true;
                setTimeout(function() { hidSuppressKey = false; }, 100);

                if (!v.duration) return;

                switch (usage) {
                    case 0x00B3: // FORWARD → 快进 60s
                        hlsSeek(Math.min(v.duration, v.currentTime + 60));
                        v.muted = false;
                        showProgress();
                        break;
                    case 0x00B4: // REWIND → 快退 60s
                        hlsSeek(Math.max(0, v.currentTime - 60));
                        showProgress();
                        break;
                    case 0x00B5: // NEXT → 下一集
                        (function() {
                            var pl = getPL(), idx = -1;
                            for (var i = 0; i < pl.length; i++) { if (pl[i].pickcode === curPid) { idx = i; break; } }
                            if (idx >= 0 && idx < pl.length - 1) navToPL(idx + 1);
                        })();
                        break;
                    case 0x00B6: // PREV → 上一集
                        (function() {
                            var pl = getPL(), idx = -1;
                            for (var i = 0; i < pl.length; i++) { if (pl[i].pickcode === curPid) { idx = i; break; } }
                            if (idx > 0) navToPL(idx - 1);
                        })();
                        break;
                    case 0x00CD: // PLAYPAUSE
                        v.paused ? v.play() : v.pause();
                        break;
                    case 0x0224: // HOME → 切换VR/平面
                        switchMode(!isVR);
                        break;
                }
            }

            async function connectHID() {
                if (!navigator.hid) {
                    console.log('[Player] WebHID 不可用（非Chromium或非HTTPS）');
                    return;
                }
                try {
                    // 先尝试获取已授权的设备
                    var devices = await navigator.hid.getDevices();
                    if (devices.length > 0) {
                        hidDevice = devices[0];
                        await hidDevice.open();
                        console.log('[Player] WebHID 已连接:', hidDevice.productName);
                        setupHID();
                    } else {
                        // 需要用户手动授权
                        console.log('[Player] WebHID 未授权，点击页面任意位置触发授权');
                        showToast('🎮 点击页面任意位置连接遥控器');
                        var doRequest = async function() {
                            document.removeEventListener('click', doRequest);
                            try {
                                var newDevices = await navigator.hid.requestDevice({
                                    filters: [{ usagePage: 0x0C, usage: 0x01 }]
                                });
                                if (newDevices.length > 0) {
                                    hidDevice = newDevices[0];
                                    await hidDevice.open();
                                    console.log('[Player] WebHID 已连接:', hidDevice.productName);
                                    showToast('✅ 遥控器已连接');
                                    setupHID();
                                }
                            } catch(e) {
                                console.log('[Player] WebHID 授权取消或失败:', e.message);
                            }
                        };
                        document.addEventListener('click', doRequest, { once: true });
                    }
                } catch(e) {
                    console.log('[Player] WebHID 连接异常:', e.message);
                }
            }

            function setupHID() {
                if (!hidDevice) return;
                hidDevice.addEventListener('inputreport', function(e) {
                    handleHIDReport(new Uint8Array(e.data.buffer));
                });
                hidDevice.addEventListener('disconnect', function() {
                    console.log('[Player] WebHID 断开');
                    hidDevice = null;
                    showToast('🔌 遥控器已断开');
                });
                console.log('[Player] WebHID 事件监听已就绪');
            }

            connectHID();

            // 简易 FPS 统计（S 键切换）
            const statsEl = document.createElement('div');
            statsEl.id = 'stats';
            statsEl.style.cssText = 'position:fixed;bottom:10px;left:10px;z-index:10000;background:rgba(0,0,0,0.75);color:#0f0;font:11px monospace;padding:8px 12px;border-radius:4px;display:none;line-height:1.6;pointer-events:none';
            document.getElementById('scene-box').appendChild(statsEl);
            let fpsCnt = 0, lastFps = performance.now(), fps = 0;
            function updStats() {
                if (statsEl.style.display !== 'block') { requestAnimationFrame(updStats); return; }
                if (!v.duration) { requestAnimationFrame(updStats); return; }
                fpsCnt++; const n = performance.now();
                if (n - lastFps >= 1000) { fps = fpsCnt; fpsCnt = 0; lastFps = n; }
                statsEl.innerHTML =
                    `${v.videoWidth||'--'}x${v.videoHeight||'--'} | FPS: ${fps} | ${(v.currentTime||0).toFixed(1)}/${(v.duration||0).toFixed(1)}s<br>` +
                    `Bitrate: ${(v.webkitVideoDecodedByteCount||0) ? ((v.webkitVideoDecodedByteCount||0)/1048576).toFixed(1)+' Mbps' : '--'} | Dropped: ${v.webkitDroppedFrameCount||0}`;
                requestAnimationFrame(updStats);
            }
            updStats();

            // ── 播放列表侧栏 ──
            var playlist = getPL();
            function renderPL() {
                if (!plEl) return;
                var items = getPL(), html = '<div style="color:#1e90ff;font-size:14px;margin-bottom:8px">🎬 播放列表 (' + items.length + ') &nbsp;<span style="color:#888;font-size:11px">' + (autoNext ? '🔁连播ON' : '') + '</span></div>';
                for (var i = 0; i < items.length; i++) {
                    var isCur = items[i].pickcode === curPid;
                    html += '<div data-pl-idx="' + i + '" style="padding:6px 8px;margin:2px 0;border-radius:4px;cursor:pointer;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;' + (isCur ? 'background:#1e90ff;color:#fff' : 'background:rgba(255,255,255,0.05)') + '">' + (i+1) + '. ' + items[i].name + '</div>';
                }
                plEl.innerHTML = html;
                plEl.querySelectorAll('[data-pl-idx]').forEach(function(el) {
                    el.addEventListener('click', function() {
                        var j = parseInt(this.getAttribute('data-pl-idx'));
                        if (j >= 0 && j < items.length) { navToPL(j); }
                    });
                });
            }
            var plEl = null;
            if (playlist.length > 0) {
                plEl = document.createElement('div');
                plEl.id = 'vr-playlist';
                plEl.style.cssText = 'position:fixed;top:0;right:0;width:280px;height:100vh;z-index:10001;background:rgba(0,0,0,0.85);color:#ccc;font:12px sans-serif;overflow-y:auto;transform:translateX(260px);transition:transform .25s;padding:10px;box-sizing:border-box';
                plEl.addEventListener('mouseenter', function() { plEl.style.transform = 'translateX(0)'; });
                plEl.addEventListener('mouseleave', function() { plEl.style.transform = 'translateX(260px)'; });
                document.getElementById('scene-box').appendChild(plEl);
                renderPL();
            }
            window._renderPL = renderPL;

            // ── 字幕 (HTML overlay + RAF 全屏修正) ──
            var subData = null, subVisible = false;
            var subEl = document.getElementById('sub-overlay');
            var subSpan = subEl.querySelector('span');
            // 放到 a-scene 里（全屏时才能显示）
            var sceneEl = document.querySelector('a-scene');
            if (sceneEl && subEl.parentNode !== sceneEl) sceneEl.appendChild(subEl);

            function parseSRT(raw) {
                var result = [];
                var blocks = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n\n+/);
                blocks.forEach(function (block) {
                    var lines = block.trim().split('\n');
                    if (lines.length < 2) return;
                    var timeMatch = lines[1].match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
                    if (!timeMatch) return;
                    var start = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]) + parseInt(timeMatch[4]) / 1000;
                    var end = parseInt(timeMatch[5]) * 3600 + parseInt(timeMatch[6]) * 60 + parseInt(timeMatch[7]) + parseInt(timeMatch[8]) / 1000;
                    var text = lines.slice(2).join('\n').replace(/<[^>]+>/g, '');
                    if (text.trim()) result.push({ start: start, end: end, text: text.trim() });
                });
                return result;
            }

            // 拦截 canvas.requestFullscreen → 改成 a-scene 全屏（确保字幕可见）
            setTimeout(function () {
                var canvas = document.querySelector('a-scene canvas');
                if (canvas) {
                    var origFS = canvas.requestFullscreen;
                    if (origFS) {
                        canvas.requestFullscreen = function () {
                            var scene = document.querySelector('a-scene');
                            if (scene && scene.requestFullscreen) {
                                return scene.requestFullscreen();
                            }
                            return origFS.apply(canvas, arguments);
                        };
                    }
                }
            }, 2000);

            v.addEventListener('timeupdate', function () {
                if (!subData || !subVisible) return;
                var t = v.currentTime, text = '';
                for (var i = 0; i < subData.length; i++) {
                    if (t >= subData[i].start && t <= subData[i].end) { text = subData[i].text; break; }
                }
                subSpan.textContent = text;
            });
            // (字幕解析和加载函数在后面定义)
            // 2D/VR detection

            function loadSubtitle(videoName, cid, parentCid) {
                if (!cid || !videoName) return;
                var baseName = videoName.replace(/\.[^.]+$/, '');
                console.log('[Player] loadSubtitle 开始, base=' + baseName + ', cid=' + cid + ', parentCid=' + (parentCid || 'none'));

                // 方式1: 在同目录递归搜索 .srt（含子文件夹）
                function scan(offset, subCid) {
                    var targetCid = subCid || cid;
                    console.log('[Player] scan folder cid=' + targetCid + ' offset=' + offset);
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: 'https://webapi.115.com/files?cid=' + targetCid + '&limit=1000&offset=' + offset,
                        timeout: 10000,
                        onload: function (r) {
                            console.log('[Player] scan resp status=' + r.status + ' len=' + (r.responseText ? r.responseText.length : 0));
                            try {
                                var resp = JSON.parse(r.responseText);
                                console.log('[Player] scan parsed state=' + resp.state + ' dataLen=' + (resp.data ? resp.data.length : 0) + ' count=' + resp.count);
                                if (!resp.state || !Array.isArray(resp.data)) { console.log('[Player] scan bad resp'); return; }
                                // 先找直接匹配的 .srt / .ass
                                for (var i = 0; i < resp.data.length; i++) {
                                    var f = resp.data[i];
                                    var fn = (f.n || f.file_name || '').toLowerCase();
                                    // 匹配 exact, .chs.srt, .cht.srt, .eng.srt 等变体
                                    if (fn === baseName.toLowerCase() + '.srt' || fn === baseName.toLowerCase() + '.ass' ||
                                        fn.indexOf(baseName.toLowerCase()) === 0 && (fn.endsWith('.srt') || fn.endsWith('.ass'))) {
                                        downloadSub(f);
                                        return;
                                    }
                                }
                                // 没找到：翻页 or 搜索子文件夹（同名文件夹）
                                if (resp.offset + resp.data.length < resp.count) {
                                    scan(offset + resp.data.length, targetCid);
                                } else if (subCid === undefined) {
                                    // 只在第一次 scan 时搜索同名子文件夹
                                    for (var j = 0; j < resp.data.length; j++) {
                                        var ff = resp.data[j];
                                        var fcat = ff.fid || ff.file_category;
                                        if (ff.cid && (ff.n || ff.file_name || '').toLowerCase() === baseName.toLowerCase()) {
                                            console.log('[Player] 进入子文件夹搜索:', ff.n || ff.file_name);
                                            scan(0, ff.cid);
                                            return;
                                        }
                                    }
                                }
                            } catch (e) { console.log('[Player] scan parse err:', e); }
                        },
                        onerror: function (e) { console.log('[Player] scan net err:', e); },
                        ontimeout: function () { console.log('[Player] scan timeout'); }
                    });
                }
                function downloadSub(f) {
                    var pc = f.pc || f.pick_code, fn = f.n || f.file_name;
                    console.log('[Player] 字幕找到:', fn, pc);
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: 'https://webapi.115.com/files/download?pickcode=' + pc,
                        timeout: 10000,
                        onload: function (r2) {
                            try {
                                var d2 = JSON.parse(r2.responseText);
                                var fileUrl = d2.file_url || d2.url || '';
                                if (fileUrl) {
                                    fileUrl = fileUrl.replace(/^http(s)?/, 'https');
                                    console.log('[Player] got file_url:', fileUrl);
                                    downloadSubFile(fileUrl);
                                } else {
                                    console.log('[Player] 无 file_url, keys:', Object.keys(d2).join(','));
                                }
                            } catch (e) { console.log('[Player] download parse err:', e); }
                        },
                        onerror: function () {
                            // fetchSub 回退：直接试 files/download
                            var directUrl = 'https://webapi.115.com/files/download?pickcode=' + pc;
                            console.log('[Player] fallback:', directUrl);
                            GM_xmlhttpRequest({
                                method: 'GET', url: directUrl, timeout: 15000,
                                onload: function (r3) {
                                    if (r3.responseText && r3.responseText.length > 500) {
                                        subData = parseSRT(r3.responseText);
                                        if (subData.length > 0) { subVisible = true; subEl.style.display = 'block'; }
                                    }
                                }
                            });
                        }
                    });
                }
                scan(0);
                if (parentCid && parentCid !== cid) {
                    console.log('[Player] 同时搜索 parentCid=' + parentCid);
                    scan(0, parentCid);
                }
            }

            function downloadSubFile(fileUrl, retries) {
                retries = retries || 2;
                console.log('[Player] downloadSubFile:', fileUrl, 'retries=' + retries);
                GM_xmlhttpRequest({
                    method: 'GET', url: fileUrl, timeout: 15000,
                    onload: function (r3) {
                        if (r3.responseText && r3.responseText.length > 100) {
                            console.log('[Player] 字幕内容长度:', r3.responseText.length);
                            subData = parseSRT(r3.responseText);
                            console.log('[Player] 字幕已加载:', subData.length, '条');
                            if (subData.length > 0) { subVisible = true; subEl.style.display = 'block'; return; }
                        }
                        if (retries > 0) setTimeout(function () { downloadSubFile(fileUrl, retries - 1); }, 2000);
                    },
                    onerror: function () {
                        if (retries > 0) setTimeout(function () { downloadSubFile(fileUrl, retries - 1); }, 2000);
                    }
                });
            }

            window._loadSub = loadSubtitle;
            console.log('[Player] 字幕引擎就绪');

            // 2D/VR detection
            v.addEventListener('loadedmetadata', function() {
                var ratio = v.videoWidth / v.videoHeight;
                switchMode(ratio > 1.8 && ratio < 2.2);
            });

            if (onReady) onReady();
        }

        function loadJs(u) {
            return new Promise((resolve, reject) => {
                if (document.querySelector(`script[data-115="${u}"]`)) return resolve();
                const s = document.createElement('script'); s.src = u;
                s.setAttribute('data-115', u); s.onload = resolve; s.onerror = reject;
                document.body.appendChild(s);
            });
        }

    function switchVideo(m3u8Url, title, pid, onReady) {
        curPid = pid;
        document.title = (title || pid) + ' - VR';
        // 通知浏览器有媒体播放，启用遥控器按钮
        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({ title: title || pid, artist: '115 VR Player' });
        }
        var isQuest = /Oculus|Quest/i.test(navigator.userAgent);
        if (hls) { hls.destroy(); hls = null; }
        const HSL_CFG = isQuest ? {
            // Quest 移动端：大缓冲防抖动
            maxBufferLength: 10, maxMaxBufferLength: 20,
            manifestLoadingMaxRetry: 2, manifestLoadingRetryDelay: 1000,
            levelLoadingMaxRetry: 2, levelLoadingRetryDelay: 1000,
            fragLoadingMaxRetry: 6, fragLoadingRetryDelay: 500
        } : {
            maxBufferLength: 2, maxMaxBufferLength: 2,
            manifestLoadingMaxRetry: 1,
            manifestLoadingRetryDelay: 500,
            levelLoadingMaxRetry: 1,
            levelLoadingRetryDelay: 500,
            fragLoadingMaxRetry: 2,
            fragLoadingRetryDelay: 300
        };
        if (Hls.isSupported()) {
            hls = new Hls(HSL_CFG);
            hls.on(Hls.Events.MANIFEST_PARSED, function() { v.play(); if (onReady) onReady(); });
            hls.on(Hls.Events.ERROR, function(event, data) {
                if (!data.fatal) return;
                console.log('[Player] HLS 致命错误 type=' + data.type + ' details=' + (data.details || '') + ' url=' + (data.url || '').substring(0, 120));
                var pos = v.currentTime;
                hls.destroy(); hls = null;
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: 'https://webapi.115.com/files/video?pickcode=' + curPid,
                    headers: { 'Referer': 'https://115.com/' },
                    onload: function(r) {
                        try {
                            var d = JSON.parse(r.responseText);
                            var newUrl = d.video_url || d.queue_url;
                            if (d.state && newUrl) {
                                switchVideo(newUrl.replace(/^http(s)?/, 'https'), title, curPid, function() {
                                    if (pos > 0) v.currentTime = pos;
                                });
                            } else if (d.code === 911) {
                                var capUrl = (d.data && d.data.url) ? d.data.url.replace(/^http:/, 'https:') : '';
                                if (capUrl) {
                                    var pop = window.open(capUrl, '115_captcha', 'width=500,height=420,left=' + ((screen.width-500)/2) + ',top=' + ((screen.height-420)/2));
                                    if (!pop) GM_openInTab(capUrl, true);
                                }
                                showToast('⚠ 115验证：完成弹窗验证后，点击右侧列表重试');
                                if (onReady) onReady();
                            } else { if (onReady) onReady(); }
                        } catch(e) { if (onReady) onReady(); }
                    },
                    onerror: function() { if (onReady) onReady(); }
                });
            });
            hls.loadSource(m3u8Url);
            hls.attachMedia(v);
        } else {
            v.src = m3u8Url;
            if (onReady) onReady();
        }
        document.getElementById('msg').style.display = 'none';
        v.addEventListener('ended', function autoAdv() {
            if (!autoNext) return;
            var pl = getPL(), idx = -1;
            for (var i = 0; i < pl.length; i++) { if (pl[i].pickcode === curPid) { idx = i; break; } }
            if (idx >= 0 && idx < pl.length - 1) navToPL(idx + 1);
        });
        if (window._renderPL) window._renderPL();
    }

    // 文件列表页：视频🥽VR | 文件夹🥽📁
    let n = 0;
    setInterval(() => {
        // 视频：🥽VR
        document.querySelectorAll('li[file_type="1"]:not([data-115-btn])').forEach(row => {
            row.setAttribute('data-115-btn', '1');
            const pid = row.getAttribute('pick_code'); if (!pid) return;
            const area = row.querySelector('.file-opr');
            if (!area || area.querySelector('.btn-115-vr')) return;
            n++;
            const w = document.createElement('span');
            w.style.cssText = 'margin-right:6px';
            w.innerHTML = `<a data-pid="${pid}" style="color:#ff6b35;font-weight:bold;text-decoration:none;font-size:12px;cursor:pointer" class="btn-115-vr">🥽VR</a>`;
            area.insertBefore(w, area.firstChild);
            w.querySelector('.btn-115-vr').onclick = function (e) { e.stopPropagation(); e.preventDefault(); savePL([]); GM_openInTab('https://115.com/web/lixian/?pickcode=' + pid, false); };
        });
        if (n > 0) { console.log('[115Player] ✅', n, '个按钮'); n = 0; }
    }, 2000);

    // 文件夹：🥽📁 一键获取目录内所有视频
    setInterval(() => {
        document.querySelectorAll('li[file_type="0"]:not([data-115-folder-btn])').forEach(row => {
            row.setAttribute('data-115-folder-btn', '1');
            const fpc = row.getAttribute('pick_code');
            if (!fpc) return;
            const area = row.querySelector('.file-opr');
            if (!area || area.querySelector('.btn-115-folder-vr')) return;
            const fw = document.createElement('span');
            fw.style.cssText = 'margin-right:6px';
            fw.innerHTML = '<a style="color:#1e90ff;font-weight:bold;text-decoration:none;font-size:12px;cursor:pointer" class="btn-115-folder-vr">🥽📁</a>';
            area.insertBefore(fw, area.firstChild);
            fw.querySelector('.btn-115-folder-vr').onclick = function(e) {
                e.stopPropagation(); e.preventDefault();
                showToast('⏳ 正在获取目录...');
                var parentCid = new URL(location.href).searchParams.get('cid') || '0';
                var fcid = null;
                function scanPage(offset) {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: 'https://webapi.115.com/files?cid=' + parentCid + '&limit=1000&offset=' + offset,
                        onload: function(r) {
                            try {
                                var resp = JSON.parse(r.responseText);
                                if (resp.state && Array.isArray(resp.data)) {
                                    for (var i = 0; i < resp.data.length; i++) {
                                        if (resp.data[i].pc === fpc || resp.data[i].pick_code === fpc) {
                                            fcid = resp.data[i].cid;
                                            break;
                                        }
                                    }
                                    if (!fcid && resp.offset + resp.data.length < resp.count) {
                                        scanPage(offset + resp.data.length);
                                        return;
                                    }
                                }
                            } catch(ex) {}
                            if (!fcid) { showToast('⚠ 未找到目录ID'); return; }
                            loadFolderVideos(fcid);
                        },
                        onerror: function() { showToast('⚠ 网络错误'); }
                    });
                }
                scanPage(0);
                function loadFolderVideos(fcid) {
                    var allPids = [], allNames = [];
                    function fetchPage(offset) {
                        GM_xmlhttpRequest({
                            method: 'GET',
                            url: 'https://webapi.115.com/files?cid=' + fcid + '&limit=30&offset=' + offset,
                            onload: function(r) {
                                try {
                                    var resp = JSON.parse(r.responseText);
                                    if (!resp.state || !Array.isArray(resp.data)) { done(); return; }
                                    resp.data.forEach(function(f) {
                                        var pc = f.pc || f.pick_code;
                                        if (pc && f.iv == 1 && f.fc !== 0) {
                                            allPids.push(pc);
                                            allNames.push(f.n || f.file_name || '');
                                        }
                                    });
                                    if (resp.offset + resp.data.length < resp.count) {
                                        setTimeout(function() { fetchPage(offset + resp.data.length); }, 600);
                                    } else { done(); }
                                } catch(ex) { done(); }
                            },
                            onerror: function() { done(); }
                        });
                    }
                    function done() {
                        if (allPids.length === 0) { showToast('⚠ 目录下没有视频'); return; }
                        // 清空旧列表，只保留当前文件夹的视频
                        var list = [];
                        for (var i = 0; i < allPids.length; i++) {
                            list.push({ pickcode: allPids[i], name: allNames[i] || allPids[i], cid: fcid, ts: Date.now() });
                        }
                        if (list.length > 200) list.length = 200;
                        savePL(list);
                        showToast('📁 已加入 ' + allPids.length + ' 个视频到播放列表');
                        GM_openInTab('https://115.com/web/lixian/?pickcode=' + allPids[0], false);
                    }
                    fetchPage(0);
                }
            };
        });
    }, 2000);
})();
