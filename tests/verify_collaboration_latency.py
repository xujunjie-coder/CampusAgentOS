"""Opt-in real-model latency check; does not save conversation messages."""
import asyncio
from contextlib import aclosing
import json
import os
from pathlib import Path
import sys
import time

os.environ["AGENTICA_LOG_LEVEL"] = "CRITICAL"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.agent_service import resolve_employee, stream_answer


async def main():
    start = time.monotonic()
    tasks, returned = set(), []
    reasoning_chars, answer = 0, ""
    history = [
        {"role": "user", "content": "我正在比较考研和就业，请分别梳理准备事项与时间安排，再汇总成对照表。开始前请先询问我的年级、专业和目标。"},
        {"role": "assistant", "content": "请补充你的年级、专业，以及考研和就业的目标。"},
    ]

    def report(**data):
        print(json.dumps({"seconds": round(time.monotonic() - start, 2), **data}, ensure_ascii=False), flush=True)

    try:
        async with asyncio.timeout(200):
            async with aclosing(stream_answer(
                "大三计算机类，考虑省外学硕和企业就业。", "collaboration-latency-check",
                resolve_employee(""), history=history,
            )) as events:
                async for event in events:
                    if event["type"] == "tool" and event["name"] == "task":
                        tasks.add(event["call_id"])
                        report(event="child_started", count=len(tasks))
                    elif event["type"] == "tool_result" and event["name"] == "task":
                        returned.append(event["status"])
                        report(event="child_returned", status=event["status"], result_length=len(event.get("result", "")))
                    elif event["type"] == "reasoning":
                        reasoning_chars += len(event["text"])
                    elif event["type"] == "done":
                        answer = event["answer"]
    except Exception as exc:
        report(event="failed", error_type=type(exc).__name__, started=len(tasks), returned=returned)
        return 1
    success = len(tasks) >= 2 and len(returned) == len(tasks) and all(s == "completed" for s in returned) and bool(answer)
    report(event="finished", success=success, started=len(tasks), returned=returned,
           reasoning_chars=reasoning_chars, answer_length=len(answer))
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
