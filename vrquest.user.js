// ==UserScript==
// @name         VR Quest
// @namespace    https://greasyfork.org/
// @version      1.1
// @description  115 Cloud：A-Frame 1.8 180° VR Player + WebHID 遥控器支持
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

    // 导航播放列表（队列化）
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
            console.log('[VRQuest] 尝试加载字幕, name=' + name + ', cid=' + cid);
            if (window._loadSub) { window._loadSub(name, cid, parentCid); }
        }
    }

    function deleteCurrentVideo() {
        if (!curPid || !curFileId) { showToast('⚠ 无法获取文件信息'); return; }
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
                    if (d.state) {
                        showToast('✅ 已删除');
                        var list = getPL(), delIdx = -1;
                        for (var i = 0; i < list.length; i++) {
                            if (list[i].pickcode === curPid) { delIdx = i; break; }
                        }
                        list = list.filter(function(x) { return x.pickcode !== curPid; });
                        savePL(list);
                        if (window._renderPL) window._renderPL();
                        if (delIdx >= 0 && delIdx < list.length) { navToPL(delIdx); }
                        else if (list.length > 0) { navToPL(list.length - 1); }
                        else { showToast('📭 播放列表已空'); }
                    } else {
                        showToast('❌ 删除失败: ' + (d.msg || d.error || ''));
                    }
                } catch(e) { showToast('❌ 删除失败'); }
            },
            onerror: function() { showToast('❌ 网络错误'); }
        });
    }

    function loadVideo(pid, fallbackName, cid, onReady) {
        var url = 'https://webapi.115.com/files/video?pickcode=' + pid;
        if (cid) url += '&cid=' + cid;
        GM_xmlhttpRequest({
            method: 'GET', url: url,
            onload: function(res) {
                try {
                    var d = JSON.parse(res.responseText);
                    if (!d.state) {
                        if (d.code === 911) {
                            var capUrl = (d.data && d.data.url) ? d.data.url.replace(/^http:/, 'https:') : '';
                            if (capUrl) {
                                var pop = window.open(capUrl, '115_captcha', 'width=500,height=420,left='+((screen.width-500)/2)+',top='+((screen.height-420)/2));
                                if (!pop) GM_openInTab(capUrl, true);
                            }
                            showToast('⚠ 115验证：完成弹窗验证后重试');
                            if (onReady) onReady();
                            return;
                        }
                        showToast('❌ 获取视频失败 (' + (d.code || d.errorno || '') + ')');
                        if (onReady) onReady();
                        return;
                    }
                    var name = d.file_name || fallbackName || pid;
                    curFileId = d.file_id || '';
                    curParentId = d.parent_id || '';
                    if (cid || curParentId) loadSubIfReady(cid || curParentId, name, curParentId);
                    var videoUrl = d.video_url;
                    if (videoUrl) { switchVideo(videoUrl.replace(/^http(s)?/, 'https'), name, pid, onReady); return; }
                    if (d.queue_url) {
                        showToast('⏭ 转码中，自动跳过');
                        if (onReady) onReady();
                        var pl = getPL(), idx = -1;
                        for (var i = 0; i < pl.length; i++) { if (pl[i].pickcode === pid) { idx = i; break; } }
                        if (idx >= 0 && idx < pl.length - 1) navToPL(idx + 1);
                        return;
                    }
                    fetchVideoUrl(pid, curFileId, name, onReady, null, null);
                } catch (e) {
                    console.log('[VRQuest] loadVideo 解析异常', e);
                    showToast('❌ 数据解析失败');
                    if (onReady) onReady();
                }
            },
            onerror: function() {
                showToast('❌ 网络错误，3秒后重试...');
                setTimeout(function() { loadVideo(pid, fallbackName, cid, onReady); }, 3000);
            },
            ontimeout: function() {
                showToast('❌ 请求超时，3秒后重试...');
                setTimeout(function() { loadVideo(pid, fallbackName, cid, onReady); }, 3000);
            },
            timeout: 15000
        });
    }

    function fetchVideoUrl(pid, fileId, name, onReady, queueUrl) {
        if (queueUrl) { pollTranscode(queueUrl, 0, name, pid, onReady); return; }
        var url1 = 'https://webapi.115.com/files/video?pickcode=' + pid;
        if (fileId) url1 += '&file_id=' + fileId;
        GM_xmlhttpRequest({
            method: 'GET', url: url1, timeout: 15000,
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

    function pollTranscode(queueUrl, count, name, pid, onReady) {
        if (count > 40) { showToast('❌ 转码超时'); if (onReady) onReady(); return; }
        GM_xmlhttpRequest({
            method: 'GET', url: queueUrl.replace(/^http(s)?/, 'https'), timeout: 10000,
            onload: function(r) {
                try {
                    var d = JSON.parse(r.responseText);
                    var realUrl = d.video_url || d.url || d.file_url ||
                        (d.data && (d.data.video_url || d.data.url || d.data.file_url));
                    if (realUrl) { switchVideo(realUrl.replace(/^http(s)?/, 'https'), name, pid, onReady); return; }
                } catch(e) {}
                setTimeout(function() { pollTranscode(queueUrl, count + 1, name, pid, onReady); }, 1500);
            },
            onerror: function() { setTimeout(function() { pollTranscode(queueUrl, count + 1, name, pid, onReady); }, 2000); }
        });
    }

    async function initScene(onReady) {
        document.head.innerHTML = '<meta charset="utf-8"><title>VR Player</title>';
        document.body.style.cssText = 'margin:0;padding:0;background:#000;overflow:hidden';

        // A-Frame 1.8 要求 DOM 里没有 a-scene 时加载
        document.body.innerHTML = '<div id="msg" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#aaa;font-size:16px;z-index:10">⏳ 加载中...</div>';
        await loadJs('https://cdn.jsdelivr.net/npm/hls.js@1.6.16/dist/hls.min.js');
        await loadJs('https://aframe.io/releases/1.8.0/aframe.min.js');

        // 在 A-Frame 加载后再注入场景 HTML
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
            '<div id="msg" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#aaa;font-size:16px;z-index:10"></div>';
        console.log('[VRQuest] 就绪');

        // 180° SBS UV：取左眼画面
        (function fixUV() {
            try {
                const sphere = document.getElementById('vr-sphere');
                const mesh = sphere.getObject3D('mesh');
                if (!mesh) { sphere.addEventListener('loaded', fixUV); return; }
                const uv = mesh.geometry.attributes.uv;
                if (!uv) return;
                for (let i = 0; i < uv.count; i++) { uv.setX(i, uv.getX(i) * 0.5); }
                uv.needsUpdate = true;
            } catch(e) {
                console.log('[VRQuest] fixUV 推迟:', e.message);
                var sphere = document.getElementById('vr-sphere');
                if (sphere) sphere.addEventListener('loaded', fixUV);
            }
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

        var pendingSeek = null;
        v.addEventListener('seeked', function() {
            if (pendingSeek !== null) { var t = pendingSeek; pendingSeek = null; v.currentTime = t; }
        });
        function hlsSeek(t) {
            if (!hls) return;
            if (v.seeking) { pendingSeek = t; } else { v.currentTime = t; }
        }

        const progBar = document.getElementById('progress-bar');
        const progFill = document.getElementById('progress-fill');
        let progTimer = 0;
        function showProgress() {
            if (!v.duration) return;
            progFill.style.width = (v.currentTime / v.duration * 100) + '%';
            progBar.style.display = 'block';
            clearTimeout(progTimer);
            progTimer = setTimeout(function() { progBar.style.display = 'none'; }, 2000);
        }

        // WebHID: 蓝牙遥控器 → 转键盘事件 → _115Key 统一处理
        var hidDevice = null;
        var HID_TO_KEY = {
            0x00B3: 'ArrowRight',  // FORWARD → 快进
            0x00B4: 'ArrowLeft',   // REWIND  → 快退
            0x00B5: 'ArrowDown',   // NEXT    → 下一集
            0x00B6: 'ArrowUp',     // PREV    → 上一集
            0x00CD: ' ',           // PLAYPAUSE
            0x0224: 'v'            // HOME → 切换VR/平面
        };

        var lastKey = null;
        function handleHIDReport(data) {
            var usage = data[0] | (data[1] << 8);
            console.log('[VRQuest] 🎮 WebHID usage=0x' + usage.toString(16).toUpperCase().padStart(4, '0'));
            if (usage === 0) {
                // 按键释放
                if (lastKey) { window.dispatchEvent(new KeyboardEvent('keyup', { key: lastKey, bubbles: true })); lastKey = null; }
                return;
            }
            var key = HID_TO_KEY[usage];
            if (!key) return;
            lastKey = key;
            window.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true }));
        }

        function setupHID() {
            if (!hidDevice) return;
            hidDevice.addEventListener('inputreport', function(e) { handleHIDReport(new Uint8Array(e.data.buffer)); });
            hidDevice.addEventListener('disconnect', function() { console.log('[VRQuest] WebHID 断开'); hidDevice = null; });
        }

        async function connectHID() {
            if (!navigator.hid) return;
            try {
                var devices = await navigator.hid.getDevices();
                if (devices.length > 0) {
                    hidDevice = devices[0]; await hidDevice.open();
                    console.log('[VRQuest] WebHID 已连接:', hidDevice.productName);
                    setupHID();
                } else {
                    console.log('[VRQuest] WebHID 未授权，点击页面触发授权');
                    showToast('🎮 点击页面连接遥控器');
                    document.addEventListener('click', function doReq() {
                        document.removeEventListener('click', doReq);
                        navigator.hid.requestDevice({ filters: [{ usagePage: 0x0C, usage: 0x01 }] })
                            .then(function(devs) { if (devs.length > 0) { hidDevice = devs[0]; return hidDevice.open(); } })
                            .then(function() { if (hidDevice) { setupHID(); showToast('✅ 遥控器已连接'); } })
                            .catch(function(e) { console.log('[VRQuest] WebHID 授权取消:', e.message); });
                    }, { once: true });
                }
            } catch(e) { console.log('[VRQuest] WebHID 异常:', e.message); }
        }
        connectHID();

        // 键盘：遥控器按键通过 WebHID dispatch 到这里统一处理
        var seekTimer = null, seekDir = 0;
        function startSeek(dir) {
            if (seekTimer) return;
            seekDir = dir;
            function tick() {
                if (!v.duration || seekDir === 0) { stopSeek(); return; }
                if (seekDir > 0) { v.muted = false; hlsSeek(Math.min(v.duration, v.currentTime + 60)); }
                else { hlsSeek(Math.max(0, v.currentTime - 60)); }
                showProgress();
                seekTimer = setTimeout(tick, 150);
            }
            tick();
        }
        function stopSeek() {
            clearTimeout(seekTimer); seekTimer = null; seekDir = 0;
        }

        var _115Key = function (e) {
            if (!v.duration) return;
            if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
                if (e.type === 'keydown') startSeek(-1);
                else stopSeek();
                e.preventDefault();
            }
            else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
                if (e.type === 'keydown') startSeek(1);
                else stopSeek();
                e.preventDefault();
            }
            else if (e.key === 'ArrowUp') {
                var pl = getPL(), idx = -1;
                for (var i = 0; i < pl.length; i++) { if (pl[i].pickcode === curPid) { idx = i; break; } }
                if (idx > 0) navToPL(idx - 1);
                e.preventDefault();
            }
            else if (e.key === 'ArrowDown') {
                var pl = getPL(), idx = -1;
                for (var i = 0; i < pl.length; i++) { if (pl[i].pickcode === curPid) { idx = i; break; } }
                if (idx >= 0 && idx < pl.length - 1) navToPL(idx + 1);
                e.preventDefault();
            }
            else if (e.key === ' ') { v.paused ? v.play() : v.pause(); e.preventDefault(); }
            else if (e.key === 'v' && !e.ctrlKey && !e.altKey) { switchMode(!isVR); }
            else if (e.key === 'a' && !e.ctrlKey && !e.altKey) {
                autoNext = !autoNext;
                GM_setValue('vr_auto_next', autoNext);
                showToast(autoNext ? '▶ 自动连播: ON' : '▶ 自动连播: OFF');
            }
            else if (e.key === 's' && !e.ctrlKey && !e.altKey) {
                var st = document.getElementById('stats');
                st.style.display = st.style.display === 'block' ? 'none' : 'block';
            }
            else if (e.key === 'c' && !e.ctrlKey && !e.altKey) {
                if (subData && subData.length > 0) {
                    subVisible = !subVisible;
                    subEl.style.display = subVisible ? 'block' : 'none';
                    showToast(subVisible ? '💬 字幕: ON' : '💬 字幕: OFF');
                }
            }
            else if (e.key === 'Delete' && !e.ctrlKey && !e.altKey) { deleteCurrentVideo(); e.preventDefault(); }
        };
        window.addEventListener('keydown', _115Key);
        window.addEventListener('keyup', _115Key);

        // FPS 统计
        var statsEl = document.createElement('div');
        statsEl.id = 'stats';
        statsEl.style.cssText = 'position:fixed;bottom:10px;left:10px;z-index:10000;background:rgba(0,0,0,0.75);color:#0f0;font:11px monospace;padding:8px 12px;border-radius:4px;display:none;line-height:1.6;pointer-events:none';
        document.getElementById('scene-box').appendChild(statsEl);
        var fpsCnt = 0, lastFps = performance.now(), fps = 0;
        function updStats() {
            if (statsEl.style.display !== 'block') { requestAnimationFrame(updStats); return; }
            if (!v.duration) { requestAnimationFrame(updStats); return; }
            fpsCnt++; var n = performance.now();
            if (n - lastFps >= 1000) { fps = fpsCnt; fpsCnt = 0; lastFps = n; }
            statsEl.innerHTML = (v.videoWidth||'')+'x'+(v.videoHeight||'')+' | FPS:'+fps+' | '+(v.currentTime||0).toFixed(1)+'/'+(v.duration||0).toFixed(1)+'s<br>Dropped:'+(v.webkitDroppedFrameCount||0);
            requestAnimationFrame(updStats);
        }
        updStats();

        // 播放列表侧栏
        var playlist = getPL();
        function renderPL() {
            if (!plEl) return;
            var items = getPL(), html = '<div style="color:#1e90ff;font-size:14px;margin-bottom:8px">🎬 播放列表 ('+items.length+') '+(autoNext?'🔁连播ON':'')+'</div>';
            for (var i = 0; i < items.length; i++) {
                var isCur = items[i].pickcode === curPid;
                html += '<div data-pl-idx="'+i+'" style="padding:6px 8px;margin:2px 0;border-radius:4px;cursor:pointer;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;'+(isCur?'background:#1e90ff;color:#fff':'background:rgba(255,255,255,0.05)')+'">'+(i+1)+'. '+items[i].name+'</div>';
            }
            plEl.innerHTML = html;
            plEl.querySelectorAll('[data-pl-idx]').forEach(function(el) {
                el.addEventListener('click', function() {
                    var j = parseInt(this.getAttribute('data-pl-idx'));
                    if (j >= 0 && j < items.length) navToPL(j);
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

        // 字幕
        var subData = null, subVisible = false;
        var subEl = document.getElementById('sub-overlay');
        var subSpan = subEl.querySelector('span');
        var sceneEl = document.querySelector('a-scene');
        if (sceneEl && subEl.parentNode !== sceneEl) sceneEl.appendChild(subEl);

        function parseSRT(raw) {
            var result = [];
            var blocks = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n\n+/);
            blocks.forEach(function(block) {
                var lines = block.trim().split('\n');
                if (lines.length < 2) return;
                var m = lines[1].match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
                if (!m) return;
                var start = parseInt(m[1])*3600+parseInt(m[2])*60+parseInt(m[3])+parseInt(m[4])/1000;
                var end = parseInt(m[5])*3600+parseInt(m[6])*60+parseInt(m[7])+parseInt(m[8])/1000;
                var text = lines.slice(2).join('\n').replace(/<[^>]+>/g, '');
                if (text.trim()) result.push({ start:start, end:end, text:text.trim() });
            });
            return result;
        }

        setTimeout(function() {
            var canvas = document.querySelector('a-scene canvas');
            if (canvas && canvas.requestFullscreen) {
                var origFS = canvas.requestFullscreen;
                canvas.requestFullscreen = function() {
                    var scene = document.querySelector('a-scene');
                    return scene && scene.requestFullscreen ? scene.requestFullscreen() : origFS.apply(canvas, arguments);
                };
            }
        }, 2000);

        v.addEventListener('timeupdate', function() {
            if (!subData || !subVisible) return;
            var t = v.currentTime, text = '';
            for (var i = 0; i < subData.length; i++) {
                if (t >= subData[i].start && t <= subData[i].end) { text = subData[i].text; break; }
            }
            subSpan.textContent = text;
        });

        function loadSubtitle(videoName, cid, parentCid) {
            if (!cid || !videoName) return;
            var baseName = videoName.replace(/\.[^.]+$/, '');
            console.log('[VRQuest] loadSubtitle:', baseName, cid);
            function scan(offset, subCid) {
                var tCid = subCid || cid;
                GM_xmlhttpRequest({
                    method: 'GET', url: 'https://webapi.115.com/files?cid='+tCid+'&limit=1000&offset='+offset, timeout: 10000,
                    onload: function(r) {
                        try {
                            var resp = JSON.parse(r.responseText);
                            if (!resp.state || !Array.isArray(resp.data)) return;
                            for (var i = 0; i < resp.data.length; i++) {
                                var f = resp.data[i], fn = (f.n||f.file_name||'').toLowerCase();
                                if (fn === baseName.toLowerCase()+'.srt' || fn === baseName.toLowerCase()+'.ass' ||
                                    (fn.indexOf(baseName.toLowerCase())===0 && (fn.endsWith('.srt')||fn.endsWith('.ass')))) {
                                    downloadSub(f); return;
                                }
                            }
                            if (resp.offset+resp.data.length < resp.count) { scan(offset+resp.data.length, tCid); }
                            else if (!subCid) {
                                for (var j = 0; j < resp.data.length; j++) {
                                    var ff = resp.data[j];
                                    if (ff.cid && (ff.n||ff.file_name||'').toLowerCase() === baseName.toLowerCase()) {
                                        scan(0, ff.cid); return;
                                    }
                                }
                            }
                        } catch(e) {}
                    }
                });
            }
            function downloadSub(f) {
                var pc = f.pc||f.pick_code;
                GM_xmlhttpRequest({
                    method: 'GET', url: 'https://webapi.115.com/files/download?pickcode='+pc, timeout: 10000,
                    onload: function(r2) {
                        try {
                            var d2 = JSON.parse(r2.responseText);
                            var fileUrl = (d2.file_url||d2.url||'').replace(/^http(s)?/,'https');
                            if (fileUrl) downloadSubFile(fileUrl);
                        } catch(e) {}
                    },
                    onerror: function() {
                        GM_xmlhttpRequest({
                            method: 'GET', url: 'https://webapi.115.com/files/download?pickcode='+pc, timeout: 15000,
                            onload: function(r3) {
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
            if (parentCid && parentCid !== cid) scan(0, parentCid);
        }

        function downloadSubFile(fileUrl, retries) {
            retries = retries || 2;
            GM_xmlhttpRequest({
                method: 'GET', url: fileUrl, timeout: 15000,
                onload: function(r) {
                    if (r.responseText && r.responseText.length > 100) {
                        subData = parseSRT(r.responseText);
                        if (subData.length > 0) { subVisible = true; subEl.style.display = 'block'; return; }
                    }
                    if (retries > 0) setTimeout(function() { downloadSubFile(fileUrl, retries-1); }, 2000);
                },
                onerror: function() { if (retries > 0) setTimeout(function() { downloadSubFile(fileUrl, retries-1); }, 2000); }
            });
        }

        window._loadSub = loadSubtitle;
        console.log('[VRQuest] 字幕引擎就绪');

        v.addEventListener('loadedmetadata', function() {
            var ratio = v.videoWidth / v.videoHeight;
            switchMode(ratio > 1.8 && ratio < 2.2);
        });

        if (onReady) onReady();
    }

    function loadJs(u) {
        return new Promise(function(resolve, reject) {
            if (document.querySelector('script[data-115="'+u+'"]')) return resolve();
            var s = document.createElement('script');
            s.src = u; s.setAttribute('data-115', u);
            s.onload = resolve; s.onerror = reject;
            document.body.appendChild(s);
        });
    }

    function switchVideo(m3u8Url, title, pid, onReady) {
        curPid = pid;
        document.title = (title || pid) + ' - VR';
        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({ title: title||pid, artist: '115 VR Player' });
        }
        if (hls) { hls.destroy(); hls = null; }
        if (Hls.isSupported()) {
            hls = new Hls({
                maxBufferLength: 2, maxMaxBufferLength: 2,
                manifestLoadingMaxRetry: 1, manifestLoadingRetryDelay: 500,
                levelLoadingMaxRetry: 1, levelLoadingRetryDelay: 500,
                fragLoadingMaxRetry: 2, fragLoadingRetryDelay: 300
            });
            hls.on(Hls.Events.MANIFEST_PARSED, function() { v.play(); if (onReady) onReady(); });
            hls.on(Hls.Events.ERROR, function(event, data) {
                if (!data.fatal) return;
                console.log('[VRQuest] HLS 致命错误:', data.type, data.details);
                var pos = v.currentTime;
                hls.destroy(); hls = null;
                GM_xmlhttpRequest({
                    method: 'GET', url: 'https://webapi.115.com/files/video?pickcode='+curPid,
                    headers: { 'Referer': 'https://115.com/' },
                    onload: function(r) {
                        try {
                            var d = JSON.parse(r.responseText);
                            var newUrl = d.video_url || d.queue_url;
                            if (d.state && newUrl) {
                                switchVideo(newUrl.replace(/^http(s)?/,'https'), title, curPid, function() {
                                    if (pos > 0) v.currentTime = pos;
                                });
                            } else if (d.code === 911) {
                                var capUrl = (d.data&&d.data.url) ? d.data.url.replace(/^http:/,'https:') : '';
                                if (capUrl) {
                                    var pop = window.open(capUrl, '115_captcha', 'width=500,height=420,left='+((screen.width-500)/2)+',top='+((screen.height-420)/2));
                                    if (!pop) GM_openInTab(capUrl, true);
                                }
                                showToast('⚠ 115验证：完成弹窗验证后重试');
                            }
                            if (onReady) onReady();
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

    // 文件列表页：🥽VR
    setInterval(function() {
        document.querySelectorAll('li[file_type="1"]:not([data-115-btn])').forEach(function(row) {
            row.setAttribute('data-115-btn', '1');
            var pid = row.getAttribute('pick_code'); if (!pid) return;
            var area = row.querySelector('.file-opr');
            if (!area || area.querySelector('.btn-115-vr')) return;
            var w = document.createElement('span');
            w.style.cssText = 'margin-right:6px';
            w.innerHTML = '<a data-pid="'+pid+'" style="color:#ff6b35;font-weight:bold;text-decoration:none;font-size:12px;cursor:pointer" class="btn-115-vr">🥽VR</a>';
            area.insertBefore(w, area.firstChild);
            w.querySelector('.btn-115-vr').onclick = function(e) {
                e.stopPropagation(); e.preventDefault();
                savePL([]);
                GM_openInTab('https://115.com/web/lixian/?pickcode='+pid, false);
            };
        });
    }, 2000);

    // 文件夹：🥽📁
    setInterval(function() {
        document.querySelectorAll('li[file_type="0"]:not([data-115-folder-btn])').forEach(function(row) {
            row.setAttribute('data-115-folder-btn', '1');
            var fpc = row.getAttribute('pick_code'); if (!fpc) return;
            var area = row.querySelector('.file-opr');
            if (!area || area.querySelector('.btn-115-folder-vr')) return;
            var fw = document.createElement('span');
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
                        method: 'GET', url: 'https://webapi.115.com/files?cid='+parentCid+'&limit=1000&offset='+offset,
                        onload: function(r) {
                            try {
                                var resp = JSON.parse(r.responseText);
                                if (resp.state && Array.isArray(resp.data)) {
                                    for (var i = 0; i < resp.data.length; i++) {
                                        if (resp.data[i].pc === fpc || resp.data[i].pick_code === fpc) { fcid = resp.data[i].cid; break; }
                                    }
                                    if (!fcid && resp.offset+resp.data.length < resp.count) { scanPage(offset+resp.data.length); return; }
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
                            method: 'GET', url: 'https://webapi.115.com/files?cid='+fcid+'&limit=30&offset='+offset,
                            onload: function(r) {
                                try {
                                    var resp = JSON.parse(r.responseText);
                                    if (!resp.state || !Array.isArray(resp.data)) { done(); return; }
                                    resp.data.forEach(function(f) {
                                        var pc = f.pc || f.pick_code;
                                        if (pc && f.iv == 1 && f.fc !== 0) { allPids.push(pc); allNames.push(f.n||f.file_name||''); }
                                    });
                                    if (resp.offset+resp.data.length < resp.count) {
                                        setTimeout(function() { fetchPage(offset+resp.data.length); }, 600);
                                    } else { done(); }
                                } catch(ex) { done(); }
                            },
                            onerror: function() { done(); }
                        });
                    }
                    function done() {
                        if (allPids.length === 0) { showToast('⚠ 目录下没有视频'); return; }
                        var list = [];
                        for (var i = 0; i < allPids.length; i++) list.push({ pickcode:allPids[i], name:allNames[i]||allPids[i], cid:fcid, ts:Date.now() });
                        if (list.length > 200) list.length = 200;
                        savePL(list);
                        showToast('📁 已加入 '+allPids.length+' 个视频到播放列表');
                        GM_openInTab('https://115.com/web/lixian/?pickcode='+allPids[0], false);
                    }
                    fetchPage(0);
                }
            };
        });
    }, 2000);
})();
