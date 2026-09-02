// Node loader resolve 钩子：把 server.mjs 的 "./folder_picker.mjs" 导入替换为测试替身。
// 仅在被 --import ./test/register-pickdir-mock.mjs 加载的测试进程内生效，不影响正常运行。
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "./folder_picker.mjs") {
    return {
      url: new URL("./mock-folder-picker.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
