// 注册 pickdir-mock-hook.mjs（Node 24 module.register）。
import { register } from "node:module";
register("./pickdir-mock-hook.mjs", import.meta.url);
