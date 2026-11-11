export function initialize() {}
export async function render(id: string, code: string) {
  return { svg: `<svg id="${id}"></svg>` }
}
export default { initialize, render }
