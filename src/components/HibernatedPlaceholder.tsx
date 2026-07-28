/**
 * 休眠 tab 在 keep-alive 树里的占位（docs/TAB_HIBERNATION_DESIGN.md §8）。
 *
 * 休眠 tab 必然不是 active，外层容器恒为 display:none，占位实际不可见；
 * 保留它是为了 key 稳定和语义清晰，零成本。tab 栏不置灰、不加标记——
 * 休眠是内部实现细节，用户无需感知。
 */
export function HibernatedPlaceholder({ fileName }: { fileName: string }) {
  return <div className="hibernated-placeholder" data-file-name={fileName} />;
}
