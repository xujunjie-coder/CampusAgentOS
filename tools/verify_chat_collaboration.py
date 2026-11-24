"""用已配置的真实模型验证主助理派发、子任务返回及最终汇总，不保存对话。"""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agentica import RunConfig, RunEvent
from agentica.utils.log import logger
from app.services.agent_service import build_agent, resolve_employee, collaboration_available


async def main():
    logger.setLevel("CRITICAL")
    employee = resolve_employee("")
    if not collaboration_available(employee):
        print(json.dumps({"success": False, "reason": "默认助理未启用协同"}, ensure_ascii=False))
        return 1
    agent = build_agent("collaboration-verification", employee, isolated=True)
    started, completed, statuses, answer = set(), set(), [], []
    prompt = (
        "请验证校园资料协同：必须在同一轮分别调用两个 task，subagent_type=campus_research。"
        "第一路调用 campus_calendar 查校历，第二路调用 campus_directory 查校园办事部门。"
        "工具未启用时请子助手明确报告缺口，不要编造。最后根据两个子助手的结果简短汇总，"
        "说明是否拿到资料及其局限，不需要再派发任务。"
    )
    try:
        async with asyncio.timeout(180):
            async for response in agent.run_stream(prompt, config=RunConfig(stream_intermediate_steps=True)):
                call = response.tool_call
                if call is not None and call.tool_name == "task":
                    if response.event == RunEvent.tool_call_started:
                        started.add(call.tool_call_id)
                    elif response.event in (RunEvent.tool_call_completed, RunEvent.tool_call_failed):
                        completed.add(call.tool_call_id)
                        try:
                            result = json.loads(call.content)
                        except (TypeError, ValueError):
                            result = {}
                        statuses.append("completed" if result.get("success") else result.get("status", "failed"))
                if response.event == RunEvent.run_response and response.content:
                    answer.append(response.content)
    except Exception as error:
        print(json.dumps({"success": False, "reason": type(error).__name__,
                          "started": len(started), "returned": len(completed)}, ensure_ascii=False))
        return 1
    success = len(started) >= 2 and started == completed and bool(answer) and all(s == "completed" for s in statuses)
    print(json.dumps({"success": success, "started": len(started), "returned": len(completed),
                      "statuses": statuses, "answer": "".join(answer)}, ensure_ascii=False))
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
