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

    const phrases = [
      "翻译术语",
      "解读条款",
      "定位条文",
      "追问细节",
      "对照版本",
    ];

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

  /* ========== 演示媒体自动加载 ========== */
  /**
   * 占位区自动升级：探测 assets/demos/ 下是否存在 {name}.mp4 或 {name}.jpg，
   * 存在则把对应 .demo-placeholder 替换为 <video> / <img>，否则保留占位。
   * 视频懒加载：滚动进入视口（提前 400px）才设置 src 开始缓冲。
   */
  function initDemoMedia() {
    const placeholders = document.querySelectorAll(".demo-placeholder[data-demo]");
    if (!placeholders.length || !window.IntersectionObserver) return;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    placeholders.forEach(function (placeholder) {
      const name = placeholder.getAttribute("data-demo");
      const base = "assets/demos/" + name;
      headOk(base + ".mp4").then(function (hasVideo) {
        if (hasVideo) {
          upgradeToVideo(placeholder, base);
          return;
        }
        headOk(base + ".jpg").then(function (hasImage) {
          if (hasImage) upgradeToImage(placeholder, base + ".jpg");
        });
      });
    });

    function headOk(url) {
      return fetch(url, { method: "HEAD" })
        .then(function (res) {
          return res.ok;
        })
        .catch(function () {
          // file:// 直接预览等场景：探测失败则保留占位
          return false;
        });
    }

    // 保留 hero-demo 等附加类，只去掉 demo-placeholder 本体
    function inheritClasses(placeholder, el) {
      const extra = Array.prototype.filter.call(
        placeholder.classList,
        function (c) {
          return c !== "demo-placeholder";
        }
      );
      el.className = ["feature-gif"].concat(extra).join(" ");
    }

    function placeholderTitle(placeholder) {
      const t = placeholder.querySelector(".demo-placeholder-title");
      return t ? t.textContent.trim() : "";
    }

    function upgradeToVideo(placeholder, base) {
      const video = document.createElement("video");
      inheritClasses(placeholder, video);
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = "none";
      video.poster = base + "-poster.jpg";
      video.setAttribute("aria-label", placeholderTitle(placeholder));
      if (reduceMotion) {
        // 减弱动态偏好：不自动播放，显示控制条交给用户
        video.controls = true;
      } else {
        video.autoplay = true;
      }
      placeholder.replaceWith(video);

      const io = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            video.src = base + ".mp4";
            video.load();
            if (video.autoplay) {
              const p = video.play();
              if (p && p.catch) p.catch(function () {});
            }
            io.disconnect();
          });
        },
        { rootMargin: "400px 0px" }
      );
      io.observe(video);
    }

    function upgradeToImage(placeholder, url) {
      const img = document.createElement("img");
      inheritClasses(placeholder, img);
      img.src = url;
      img.alt = placeholderTitle(placeholder);
      img.loading = "lazy";
      img.decoding = "async";
      placeholder.replaceWith(img);
    }
  }

  /* ========== 初始化 ========== */
  function init() {
    initTypewriter();
    initReveal();
    initDemoPlaceholders();
    initDemoMedia();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
