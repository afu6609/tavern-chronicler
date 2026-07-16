# Tavern Chronicler — SillyTavern 扩展面板

[tavern-chronicler](https://github.com/afu6609/tavern-chronicler)（`main` 分支）的配套 ST UI 扩展。本分支只含扩展文件（manifest 在根目录），供 ST 扩展安装器直接安装。

面板连接桥的 `ws://127.0.0.1:9377/admin` 管理通道：

- **配置热改**：表单由桥下发的 schema 自动生成，改完即时生效并持久化到桥的 `memory/bridge-config.json`，无需环境变量、无需重启
- **旧对话导入 + 补课**：一键把 ST 当前对话的全部楼层归档进桥的战役档案（已有匹配战役自动补全合并），并可让记忆 agent 分批补课构建档案，进度实时显示、断点续跑
- **日志实时流**：桥日志按 `[chat]` / `[recall]` / `[memory]` / `[dice]` 着色流入面板，连接时回放最近 400 行
- **缓存命中率**：面板顶部实时显示三条路径的累计平均命中率
- **用量快照**：一键查看本次运行的分路径 token 汇总

## 安装

ST → 扩展 → 安装扩展，填仓库地址并指定分支 `st-extension`：

```
https://github.com/afu6609/tavern-chronicler
```

或手动克隆：

```sh
git clone -b st-extension https://github.com/afu6609/tavern-chronicler \
  SillyTavern/public/scripts/extensions/third-party/tavern-chronicler
```

安装后刷新酒馆页面，扩展设置抽屉里即出现 **Tavern Chronicler** 面板。需要桥运行 2026-07-15 之后的版本（含 `/admin` 管理通道）。

## License

[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/deed.zh-hans)：使用、修改、分发须署名原作者（afu6609）并附仓库出处，禁止商业用途。完整条款见 [LICENSE](LICENSE)。
