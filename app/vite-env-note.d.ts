// 068：Vite 的 `?worker` 导入（pdf.js worker 打包成同源 .js 文件）。
declare module '*?worker' {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}
