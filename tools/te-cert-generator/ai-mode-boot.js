"use strict";

/**
 * 「AI 工作站」布局的早期开关。
 *
 * 这个文件**故意不写 defer**，并且必须放在 body 末尾。原因是一起真机故障：
 *
 *   展开「AI 名单工作台」时，工作区要切到 .ai-mode（隐藏设置面板、把 AI 面板提到主栏）。
 *   这件事原先只由 app.js 的 toggle 监听负责，而 app.js 是 defer 的，
 *   执行顺序排在 xlsx 与 pdf-lib 后面 —— 两个文件合计约 1.4 MB。
 *   桌面端网速快，脚本先于用户点击就绪；手机端首屏 HTML/CSS 一两秒就画出来了，
 *   脚本却要等十几秒（实测 400 kbps 下 DOMContentLoaded 约 14s）。
 *   用户在这段窗口里点开面板时：<details> 是浏览器原生行为，照常展开，
 *   但 toggle 事件**早于监听器绑定**触发，.ai-mode 于是永远补不上 ——
 *   现象是「点了 AI 工作站，出来的还是设置页那一坨」，而且再等也不会自己恢复。
 *   （真实 Chromium + 限速 + 移动视口已复现；用户的描述就是"要缓存好久之后才正常"。）
 *
 * 所以布局这一件事必须脱离大文件：本文件只有几百字节，下载与执行都在
 * 首屏那一刻完成，点开面板即时切换，等多久都不会有半路状态。
 *
 * 它只做一件事：把 #aiBlock 的 open 同步成 #workspace 的 .ai-mode。
 * 其余行为（刷新按钮、把「快速输入」内容带到 AI 输入框、聚焦）仍旧归 app.js，
 * app.js 里也保留同一份同步作为兜底 —— 本文件缺失或缓存过期时行为退回改动前。
 */
(function () {
  const block = document.getElementById("aiBlock");
  if (!block) return;

  function sync() {
    const workspace = document.getElementById("workspace");
    if (!workspace) return;
    workspace.classList.toggle("ai-mode", block.open);
  }

  sync();
  block.addEventListener("toggle", sync);
})();
