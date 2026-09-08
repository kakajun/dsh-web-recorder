import { defineConfig } from 'tsdown'

// package.json peerDependencies/dependencies 中的 @deepseek-ai/* 与 playwright-core 自动保持 external, 运行时从宿主 node_modules 解析
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  outDir: 'lib',
  // 包已声明 type: module, 输出 .js 而非 .mjs, 与 cordis.yml 中的路径一致
  fixedExtension: false,
  sourcemap: false
})
