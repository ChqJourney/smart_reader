/**
 * SpecReader AI Landing Page - 交互脚本
 * - 打字机效果
 * - 滚动入场动画
 */

(function () {
  "use strict";

  /* ========== 打字机效果 ========== */
  function initTypewriter() {
    const el = document.getElementById("typewriter");
    if (!el) return;

    const phrases = ["翻译术语", "解读条款", "整理测试要求", "追溯来源页码"];

    let phraseIndex = 0;
    let charIndex = 0;
    let isDeleting = false;
    let pauseEnd = 2000;
    let pauseStart = 300;
    let typeSpeed = 100;

    function tick() {
      const current = phrases[phraseIndex];
      const displayed = isDeleting
        ? current.substring(0, charIndex - 1)
        : current.substring(0, charIndex + 1);

      el.textContent = displayed;

      if (isDeleting) {
        charIndex--;
        typeSpeed = 60;
      } else {
        charIndex++;
        typeSpeed = 120;
      }

      if (!isDeleting && charIndex === current.length) {
        isDeleting = true;
        typeSpeed = pauseEnd;
      } else if (isDeleting && charIndex === 0) {
        isDeleting = false;
        phraseIndex = (phraseIndex + 1) % phrases.length;
        typeSpeed = pauseStart;
      }

      setTimeout(tick, typeSpeed);
    }

    tick();
  }

  /* ========== 滚动入场动画 ========== */
  function initReveal() {
    const elements = document.querySelectorAll(".reveal");
    if (!elements.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            // 可选：只触发一次；如需重复触发可注释下一行
            observer.unobserve(entry.target);
          }
        });
      },
      {
        root: null,
        rootMargin: "0px 0px -60px 0px",
        threshold: 0.12,
      }
    );

    elements.forEach((el) => observer.observe(el));
  }

  /* ========== 演示占位区提示 ========== */
  function initDemoPlaceholders() {
    const placeholders = document.querySelectorAll(".demo-placeholder");
    placeholders.forEach((placeholder) => {
      placeholder.addEventListener("click", () => {
        const hint = placeholder.querySelector(".demo-placeholder-hint");
        if (hint) {
          const original = hint.textContent;
          hint.textContent = "请将对应 GIF 放入 landing/assets/demos/ 目录";
          setTimeout(() => {
            hint.textContent = original;
          }, 2000);
        }
      });
    });
  }

  /* ========== 初始化 ========== */
  function init() {
    initTypewriter();
    initReveal();
    initDemoPlaceholders();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
