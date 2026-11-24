# 离线实验结果说明

本目录的文件由脚本生成，可重跑：

- context-experiment.json：上下文编译机制对照，不调用模型。
- mock-eval.json：MockProvider 的端到端 plumbing smoke，不代表模型能力。

## 怎么读

context-experiment.json 的 scope 明确写了“没有模型调用、没有编码能力主张、不是账单 token”。full 在长历史上因预算失败；tail 和 checkpoint 能装下，checkpoint 保留了 fixture 预置的早期事实标记。

这个对照只能说明：当前编译器在选择历史时确实会丢失早期信息，而 checkpoint 注入可以让标记重新出现在输入里。它不能说明模型会遵守标记，也不能说明真实摘要不会漏信息。

mock-eval.json 的 inputTokens 和 outputTokens 是 null，因为 Mock 没有提供 usage；null 表示未知，不是零。通过率只证明工具闭环与独立测试检查在工作，不证明真实模型能修 bug。

## 不要这样引用

- 不要说“checkpoint 让成功率提高了 X%”：当前没有真实模型对照。
- 不要说“tail 比 full 更省 token 且效果相同”：任务集太小，且没有真实模型。
- 不要说“已支持 Trae 模型”：manual 是人搬运，独立 API 未验证。
- 不要把 heuristic 估算当作 provider 账单。

## 下一步

用同一模型、同一任务起点、多次重复和独立测试跑在线对照；记录 API reported usage、失败分类和成本。只有那时才讨论效果收益。
