// ==UserScript==
// @name           Reply
// @author         Lattice Sum
// @namespace      https://greasyfork.org/
// @description    Discuz reply tool by dsoyet@outlook.com
// @version        1.2
// @create         2013-01-19
// @include        http*/thread*
// @include        http*forum.php?mod=viewthread&tid=*
// @include        http*forum.php?mod=post&action=reply&fid=*
// @include        http*forum.php?mod=post&action=newthread&fid=*
// @include        http*://keylol.com/t*
// ==/UserScript==

(function () {
    var _Q = function (d) {
        return document.querySelector(d)
    };
    var w = (typeof unsafeWindow != 'undefined') ? unsafeWindow : window;

    function $(id) {
        return !id ? null : document.getElementById(id);
    }
    //discuz_uid fid tid
    if (w.discuz_uid > 0 || _Q('#um')) { //是否登录，否则退出
        var bar = _Q('.fpd') || _Q('.bar');
        var Psfm = $('postform'),
            Fps = $('fastpostform');
        var pos = Psfm || Fps;

        //截获快捷键
        if (!window.opera) {
            w.keyDown = function () { };
        } //非O，USERJS优先权比较低
        function mess(PS) {
            var fwin = $('fwin_reply');
            PS.onkeydown = function (event) {
                if ((event.ctrlKey && event.keyCode == 13 || event.altKey && event.keyCode == 83) || (event.altKey && event.keyCode == 83)) {
                    if (Psfm) {
                        w.ctlent(event)
                    } else if (fwin) {
                        location.href = "javascript:$('postsubmit').click()";
                    } else {
                        w.seditor_ctlent(event, 'fastpostvalidate($(\'fastpostform\'))')
                    };
                }
            }
        }
        //创建选项
        var style = document.createElement("style");
        style.type = "text/css";
        style.textContent = "#mUA{ \
				margin-top:1px;border:1px solid #f6f;color:red;outline:1px solid #f6f;";
        document.head.appendChild(style);
        var Bos = document.createElement("SELECT");
        Bos.id = "mUA";
        Bos.title = "选择自动回复";
        var texts = new Array(
            "感谢楼主分享，收下了",
            "谢谢分享，正好需要这个",
            "收藏了，回头慢慢研究",
            "学习了，楼主写得很详细",
            "这个思路不错，值得参考",
            "之前一直没搞懂，看完明白了",
            "支持一下，期待后续更新",
            "请问楼主这个适用于最新版本吗",
            "试了一下确实有效，感谢",
            "Mark一下，以后用得上");
        for (var i = 0; i < texts.length; i++) {
            var option = document.createElement("option");
            option.setAttribute("value", i);
            option.appendChild(document.createTextNode(texts[i]));
            Bos.appendChild(option);
        }
        Bos.options[0].selected = true;
        //按钮
        var btn = document.createElement("button");
        btn.textContent = "自动回复";
        btn.id = "mUA_btn";
        btn.onclick = addText;

        function addText() {
            var fpmessage = document.getElementById("fastpostmessage");
            //快捷回复(最下面那个)
            if (fpmessage) {
                fastpostmessage.textContent = Bos.options[Bos.selectedIndex].text;
            }
            //独立回复界面
            else if (document.getElementById("e_iframe").contentWindow) {
                var e_iframe = document.getElementById("e_iframe").contentWindow.document.body;
                e_iframe.textContent = Bos.options[Bos.selectedIndex].text;
            }
            //快捷回复界面
            var fwin_reply_postmessage = document.getElementById("postmessage");
            if (fwin_reply_postmessage) {
                console.log(Bos.options[Bos.selectedIndex].text)
                fwin_reply_postmessage.textContent = Bos.options[Bos.selectedIndex].text;
            }
        }

        if (bar) {
            bar.appendChild(Bos);
            bar.appendChild(btn);
            mess(pos.message);
        };

        $('mUA').onchange = addText;

        //劫持楼层回复
        var ShowW = w.showWindow;
        w.showWindow = function (k, url, mode, cache, menuv) {
            setTimeout(function () {
                var pof = $('postform');
                _Q('.bar').appendChild(Bos);
                _Q('.bar').appendChild(btn);
                mess(pof.message);
            }, 1300);
            return ShowW(k, url, mode, cache, menuv);
        }

    }
})();