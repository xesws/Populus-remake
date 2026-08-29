// v0.24 世界生成模块统一出口（Agent G）：外部只从本 index 引入，不直接触碰内部文件。
export * from "./noise";
export * from "./map-template";
// v0.25 地貌特征层：契约（terrain-features）+ 各特征的独立实现（features/）。
export * from "./terrain-features";
export * from "./features/mountain-range";
export * from "./world-gen";
