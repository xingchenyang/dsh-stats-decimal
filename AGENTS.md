# Agent Instructions

修改本仓库前，完整阅读 `README.md`、`DEVELOPMENT.md` 和 `CHANGELOG.md`。

## 范围

- 当前唯一保证的 DeepSeek Harness 版本是 `v0.1.2-rc.1`。
- 不要自行承诺其他 DSH 版本兼容性；必须先验证对应源码 contract。
- 保持 README 面向使用者且简洁。发布历史写入 `CHANGELOG.md`，技术背景与接手状态写入 `DEVELOPMENT.md`。

## 必须保持

- 百分比、token 简写和金额必须截断，不得四舍五入。
- 北京时间采用固定 UTC+8；周六、周日始终使用谷价。
- 未配置价格的模型必须显示“费用未知 / Cost unknown”，不得使用其他模型价格兜底。
- 未知模型费用不得隐藏或改变 DeepSeek API 返回的余额。
- API Key 只能在 Host 侧解析和使用，不得进入浏览器、projection 或 Session 日志。
- 不得向 Session 追加插件自定义余额事件。
- 修改 projection state shape 时同步更新 state schema、wire view schema、client 消费代码和 `stateVersion`。
- 新模型只有在峰/谷、CNY/USD、cache hit/miss/output 价格完整且有依据时才可加入内置表。

## 检查

- Agent 为测试、诊断或验证临时生成的脚本、样例数据、日志和其他辅助文件必须放在 `.tools/`，不得散落在项目源码目录；正式测试套件不受此限制。

提交前运行：

```powershell
node --check lib/index.js
node --check lib/client.js
node --check lib/pricing.js
git diff --check
```

涉及计价时，还要验证工作日峰谷、北京时间周末、未知模型、自定义价格模型，以及 Vision/Flash 同价约束。

## 文档

- 用户可见变化写到 `CHANGELOG.md` 对应的插件版本章节。
- 架构、限制或关键决策变化时更新 `DEVELOPMENT.md`。
- 只有安装、配置或当前使用行为变化时才更新 `README.md`。
