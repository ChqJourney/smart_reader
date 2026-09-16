/**
 * pdfjs-dist 懒加载器：动态 import + 一次性 GlobalWorkerOptions.workerSrc
 * 设置。pdfjs 体积大（≈1MB），入口不再静态引用，所有消费方（viewer 文档
 * 加载 / Agent Tools / 打印栅格兜底）统一经此函数按需加载；缓存 promise，
 * 多次调用共享同一模块实例与 worker 配置。
 */
let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

export function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  pdfjsPromise ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })();
  return pdfjsPromise;
}
