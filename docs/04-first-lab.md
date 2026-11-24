# 动手练习 01：亲眼看一次 Agent 往返

本讲只做一个目标：看清楚模型、上下文、工具、门禁和证据分别由谁负责。先不改 Agent 代码。

## 步骤 1：确认运行环境

在项目目录的终端运行：

    npm run lab -- doctor
    npm test

预期：doctor 显示 traeDirectAPI 尚未确认，manualRelay 可用；测试全部通过。独立 API 字段此时可以全为 false，离线练习不需要 key。

## 步骤 2：Mock 到编辑提案

    npm run demo

预期顺序：list_files → read_file → 编辑提案暂停。复制输出的会话绝对路径。

    npm run lab -- inspect --session /your/session/path

打开 proposal 指定的 sum.mjs，确认仍是减法。再打开会话 events.jsonl，找本轮 request、assistant、proposal。注意此时还没有表示编辑成功的 tool_result。

问题：为什么模型能提出修改，但不应该因此宣称已经修改？

## 步骤 3：批准与验证

    npm run lab -- approve --session /your/session/path

看清旧／新片段后输入 yes，才应用到文件；测试还会再次询问，理解测试代码会在本机执行后再批准。

inspect 应能找到 approval、编辑 tool_result、run_tests tool_result 与最终 stop。只有最近编辑之后的测试通过，stop 才标记 final-test-verified。

反例：另开一个 demo 拒绝编辑，观察文件没有改变，最终不应该被验证为成功。不要给业务仓库自动批准权限。

## 步骤 4：替换成 Trae 手动模型

    npm run lab -- start --provider manual --example

打开会话的 request.md，Trae 新对话中粘贴完整文本，不允许 Trae 自己运行工具或编辑项目，只让它输出一条 JSON。

把回复存到 reply.json，然后执行：

    npm run lab -- import --session /your/session/path --reply /your/session/path/reply.json

观察这个动作究竟是谁执行：应该是本地 harness，不是 Trae 自己的 Agent。下一轮再使用新导出的请求新开对话；编辑阶段仍手动确认。

如果回复带 Markdown 围栏或 requestId 旧了，导入会失败；只修正回复文件，不跳过协议检查。重复导入同一请求会被拒绝。

## 本讲验收

- 能指出一次请求里 system、currentTask、历史动作、工具结果和当前 requestId。
- 能区分 proposal、approval、实际落盘、测试、model final 五个状态。
- 能指出一条失败原因与对应日志 seq。
- 能说明 Trae 手动通路不是直连 API，Trae 自身会附加上下文，因此结果不是正式 API 等价基准。

## 你第一次真正改代码的作业

在 context.ts 为请求增加一个只读指标：system／task／history／checkpoint 各自占多少粗估 token。不要把指标写进模型可见提示；让 inspect 能展示，并加测试验证加总与总数的关系。

先预测增加指标会不会改变模型输入：正确答案应是不改变。如果只是加一个观测指标却改了 messages 或 prefixHash，需要定位原因。

完成这个小作业后，再进入学习路线阶段 3 的裁剪／预算实验。
