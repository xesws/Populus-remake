// v0.17 敌方 AI：模块出口——统一导出配置、契约、战略大脑与指挥层（经济/训兵/军事/神力子脑由各自文件导出）。
export * from "./ai-profile";
export * from "./types";
export * from "./tribe-brain";
export * from "./ai-director";
export * from "./training-director";
// v0.37 军事升级：编制策略 / 目标选择 / 大龙计划子脑
export * from "./army-policy";
export * from "./targeting";
export * from "./dragon-director";
