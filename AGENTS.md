# Agent Instructions

修改本仓库前，完整阅读 `README.md`、`DEVELOPMENT.md` 和 `CHANGELOG.md`。

## 范围

- 插件版本以 `package.json` 的 `version` 为唯一事实源，不在本文件重复维护当前版本号。
- 当前 DeepSeek Harness 适配目标见 `README.md` / `DEVELOPMENT.md`。
- 不要自行承诺适配目标以外的 DSH 版本兼容性；必须先验证对应源码 contract。
- 保持 README 面向使用者且简洁。发布历史写入 `CHANGELOG.md`，技术背景与接手状态写入 `DEVELOPMENT.md`。

## 仓库 Git 身份与本地工作区

- 项目自有仓库使用项目专属 Safe Public Git 身份；本仓库使用 `dsh-stats-decimal <dsh-stats-decimal@example.invalid>`。不要修改全局 Git 身份。
- `.work/` 是临时本地工作区；仅 `.work/README.md` 纳入版本控制，其余内容保持忽略。
- `.githooks/` 存放维护并跟踪的仓库安全工具；本地启用身份检查 hook：`git config --local core.hooksPath .githooks`。

## 必须保持

- 百分比、token 简写和金额必须截断，不得四舍五入。
- 北京时间采用固定 UTC+8；周六、周日和已编入日历的中国法定节假日始终使用谷价，周末调休上班日仍按周末谷价处理。
- 未配置价格的模型必须显示“费用未知 / Cost unknown”，不得使用其他模型价格兜底。
- 未知模型费用不得隐藏或改变 DeepSeek API 返回的余额。
- API Key 只能在 Host 侧解析和使用，不得进入浏览器、projection 或 Session 日志。
- 余额 API Key 必须通过 DSH `credentials.resolve("DEEPSEEK_API_KEY")` 解析；不得直接读取或解析 DSH 私有凭据存储。
- 不得向 Session 追加插件自定义余额事件。
- 修改 projection state shape 时同步更新 state schema、wire view schema、client 消费代码和 `stateVersion`。
- 新模型只有在峰/谷、CNY/USD、cache hit/miss/output 价格完整且有依据时才可加入内置表。

## 检查

- Agent 为临时审查、诊断、下载、补丁和验证生成的脚本、样例数据、日志和其他辅助文件必须放在 `.work/`，不得散落在项目源码目录；维护中的项目脚本放在 `scripts/`，正式测试套件不受此限制。

提交前运行：

```powershell
node --check lib/index.js
node --check lib/client.js
node --check lib/pricing.js
git diff --check
```

涉及计价时，还要验证工作日峰谷、北京时间周末、未知模型、自定义价格模型，以及 Vision/Flash 同价约束。

## 文档

- 所有新增和修改都属于即将提交的版本；提交前核对版本号与日期。
- 用户可见变化写到 `CHANGELOG.md` 对应的插件版本章节。
- 架构、限制或关键决策变化时更新 `DEVELOPMENT.md`。
- 只有安装、配置或当前使用行为变化时才更新 `README.md`。
