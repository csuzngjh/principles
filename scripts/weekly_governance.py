#!/usr/bin/env python3
import argparse
import datetime as _dt
import json
import os
import sys

WEEK_STAGES = {
    "UNPLANNED",
    "DRAFT",
    "CHALLENGE",
    "PENDING_OWNER_APPROVAL",
    "LOCKED",
    "EXECUTING",
    "REVIEW",
    "CLOSED",
    "INTERRUPTED",
}


def _project_root():
    return os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()


def _okr_dir(project_dir):
    return os.path.join(project_dir, "docs", "okr")


def _state_path(project_dir):
    return os.path.join(_okr_dir(project_dir), "WEEK_STATE.json")


def _events_path(project_dir):
    return os.path.join(_okr_dir(project_dir), "WEEK_EVENTS.jsonl")


def _lock_path(project_dir):
    return os.path.join(_okr_dir(project_dir), "WEEK_PLAN_LOCK.json")


def _week_id(now=None):
    dt = now or _dt.datetime.now()
    iso = dt.isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def _default_state(now=None):
    ts = (now or _dt.datetime.now()).isoformat()
    return {
        "version": 1,
        "week_id": _week_id(now),
        "stage": "UNPLANNED",
        "owner_approved": False,
        "owner_decision": "",
        "owner_note": "",
        "goal": "",
        "proposer_agent": "",
        "proposal_summary": "",
        "challenger_agent": "",
        "challenge_summary": "",
        "lock": {"locked": False, "locked_at": ""},
        "execution": {
            "started_at": "",
            "last_heartbeat_at": "",
            "heartbeat_count": 0,
            "completed_events": 0,
            "blocked_events": 0,
        },
        "interruption": {"active": False, "detected_at": "", "reason": ""},
        "updated_at": ts,
    }


def _normalize_state(raw_state):
    state = _default_state()
    if not isinstance(raw_state, dict):
        return state
    for key, value in raw_state.items():
        if key not in state:
            state[key] = value
    stage = str(raw_state.get("stage") or state["stage"]).upper()
    if stage not in WEEK_STAGES:
        stage = state["stage"]
    state["stage"] = stage
    state["owner_approved"] = bool(raw_state.get("owner_approved", state["owner_approved"]))
    state["owner_decision"] = str(raw_state.get("owner_decision") or state["owner_decision"])
    state["owner_note"] = str(raw_state.get("owner_note") or state["owner_note"])
    state["goal"] = str(raw_state.get("goal") or state["goal"])
    state["proposer_agent"] = str(raw_state.get("proposer_agent") or state["proposer_agent"]).strip()
    state["proposal_summary"] = str(raw_state.get("proposal_summary") or state["proposal_summary"])
    state["challenger_agent"] = str(raw_state.get("challenger_agent") or state["challenger_agent"]).strip()
    state["challenge_summary"] = str(raw_state.get("challenge_summary") or state["challenge_summary"])

    if isinstance(raw_state.get("lock"), dict):
        state["lock"]["locked"] = bool(raw_state["lock"].get("locked", state["lock"]["locked"]))
        state["lock"]["locked_at"] = str(raw_state["lock"].get("locked_at") or state["lock"]["locked_at"])
    if isinstance(raw_state.get("execution"), dict):
        execution = raw_state["execution"]
        state["execution"]["started_at"] = str(execution.get("started_at") or state["execution"]["started_at"])
        state["execution"]["last_heartbeat_at"] = str(
            execution.get("last_heartbeat_at") or state["execution"]["last_heartbeat_at"]
        )
        state["execution"]["heartbeat_count"] = max(0, int(execution.get("heartbeat_count") or 0))
        state["execution"]["completed_events"] = max(0, int(execution.get("completed_events") or 0))
        state["execution"]["blocked_events"] = max(0, int(execution.get("blocked_events") or 0))
    if isinstance(raw_state.get("interruption"), dict):
        interruption = raw_state["interruption"]
        state["interruption"]["active"] = bool(interruption.get("active", False))
        state["interruption"]["detected_at"] = str(interruption.get("detected_at") or "")
        state["interruption"]["reason"] = str(interruption.get("reason") or "")
    state["updated_at"] = str(raw_state.get("updated_at") or state["updated_at"])
    return state


def load_state(project_dir):
    path = _state_path(project_dir)
    if not os.path.isfile(path):
        return _default_state()
    with open(path, "r", encoding="utf-8") as handle:
        return _normalize_state(json.load(handle))


def save_state(project_dir, state):
    os.makedirs(_okr_dir(project_dir), exist_ok=True)
    state["updated_at"] = _dt.datetime.now().isoformat()
    with open(_state_path(project_dir), "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)


def append_event(project_dir, event_type, summary="", **extra):
    os.makedirs(_okr_dir(project_dir), exist_ok=True)
    state = load_state(project_dir)
    payload = {
        "timestamp": _dt.datetime.now().isoformat(),
        "week_id": state.get("week_id"),
        "type": event_type,
        "summary": summary,
    }
    payload.update({k: v for k, v in extra.items() if v not in (None, "")})
    with open(_events_path(project_dir), "a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def start_week(project_dir, week_id="", goal=""):
    state = _default_state()
    state["week_id"] = week_id or _week_id()
    state["goal"] = goal or ""
    state["stage"] = "DRAFT"
    save_state(project_dir, state)
    append_event(project_dir, "week_started", summary=f"week started: {state['week_id']}")
    return state


def record_proposal(project_dir, proposer_agent, summary):
    state = load_state(project_dir)
    state["proposer_agent"] = proposer_agent.strip()
    state["proposal_summary"] = summary.strip()
    state["stage"] = "CHALLENGE"
    save_state(project_dir, state)
    append_event(project_dir, "proposal_recorded", summary=summary, agent=proposer_agent)
    return state


def record_challenge(project_dir, challenger_agent, summary):
    state = load_state(project_dir)
    proposer = str(state.get("proposer_agent") or "").strip()
    challenger = challenger_agent.strip()
    if not proposer:
        raise ValueError("Cannot record challenge before proposal.")
    if proposer == challenger:
        raise ValueError("challenger_agent must be different from proposer_agent.")
    state["challenger_agent"] = challenger
    state["challenge_summary"] = summary.strip()
    state["stage"] = "PENDING_OWNER_APPROVAL"
    save_state(project_dir, state)
    append_event(project_dir, "challenge_recorded", summary=summary, agent=challenger)
    return state


def owner_decision(project_dir, decision, note=""):
    state = load_state(project_dir)
    decision = decision.lower().strip()
    if decision not in {"approve", "revise", "reject"}:
        raise ValueError("decision must be one of: approve, revise, reject.")
    state["owner_decision"] = decision
    state["owner_note"] = note.strip()
    if decision == "approve":
        if not state.get("proposer_agent"):
            raise ValueError("cannot approve without proposal.")
        if not state.get("challenger_agent"):
            raise ValueError("cannot approve without challenge.")
        state["owner_approved"] = True
        state["stage"] = "LOCKED"
        state["lock"] = {"locked": True, "locked_at": _dt.datetime.now().isoformat()}
        save_state(project_dir, state)
        with open(_lock_path(project_dir), "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "week_id": state.get("week_id"),
                    "locked_at": state["lock"]["locked_at"],
                    "owner_note": state.get("owner_note", ""),
                },
                handle,
                ensure_ascii=False,
                indent=2,
            )
        append_event(project_dir, "owner_approved", summary=note or "approved")
        return state

    state["owner_approved"] = False
    state["lock"] = {"locked": False, "locked_at": ""}
    state["stage"] = "DRAFT"
    save_state(project_dir, state)
    if os.path.isfile(_lock_path(project_dir)):
        os.remove(_lock_path(project_dir))
    append_event(project_dir, "owner_rework", summary=note or decision)
    return state


def log_execution_event(project_dir, event_type, summary="", agent="", task=""):
    state = load_state(project_dir)
    now = _dt.datetime.now().isoformat()
    execution = state.get("execution") or {}

    if event_type in {"task_started", "heartbeat"} and state.get("stage") in {"LOCKED", "EXECUTING"}:
        if state.get("stage") == "LOCKED":
            state["stage"] = "EXECUTING"
            if not execution.get("started_at"):
                execution["started_at"] = now
        execution["last_heartbeat_at"] = now
        execution["heartbeat_count"] = int(execution.get("heartbeat_count") or 0) + 1
    if event_type == "task_completed":
        execution["completed_events"] = int(execution.get("completed_events") or 0) + 1
    if event_type == "blocker":
        execution["blocked_events"] = int(execution.get("blocked_events") or 0) + 1
    state["execution"] = execution
    save_state(project_dir, state)
    append_event(project_dir, event_type, summary=summary, agent=agent, task=task)
    return state


def mark_interrupted(project_dir, reason):
    state = load_state(project_dir)
    state["stage"] = "INTERRUPTED"
    state["interruption"] = {
        "active": True,
        "detected_at": _dt.datetime.now().isoformat(),
        "reason": reason.strip() or "manual interruption",
    }
    save_state(project_dir, state)
    append_event(project_dir, "interruption_marked", summary=state["interruption"]["reason"])
    return state


def recover_execution(project_dir, note=""):
    state = load_state(project_dir)
    if state.get("stage") != "INTERRUPTED":
        raise ValueError("recover is only valid when stage=INTERRUPTED.")
    state["stage"] = "EXECUTING"
    state["interruption"] = {"active": False, "detected_at": "", "reason": ""}
    state["execution"]["last_heartbeat_at"] = _dt.datetime.now().isoformat()
    save_state(project_dir, state)
    append_event(project_dir, "recovered", summary=note or "execution recovered")
    return state


def cmd_status(project_dir, _args):
    print(json.dumps(load_state(project_dir), ensure_ascii=False, indent=2))
    return 0


def cmd_new_week(project_dir, args):
    state = start_week(project_dir, week_id=args.week_id, goal=args.goal)
    print(f"Week initialized: {state['week_id']} (stage={state['stage']})")
    return 0


def cmd_proposal(project_dir, args):
    state = record_proposal(project_dir, args.agent, args.summary)
    print(f"Proposal recorded by {state['proposer_agent']} (stage={state['stage']})")
    return 0


def cmd_challenge(project_dir, args):
    state = record_challenge(project_dir, args.agent, args.summary)
    print(f"Challenge recorded by {state['challenger_agent']} (stage={state['stage']})")
    return 0


def cmd_owner_decision(project_dir, args):
    state = owner_decision(project_dir, args.decision, note=args.note)
    print(f"Owner decision: {state['owner_decision']} (stage={state['stage']})")
    return 0


def cmd_log_event(project_dir, args):
    log_execution_event(project_dir, args.type, summary=args.summary, agent=args.agent, task=args.task)
    print(f"Event logged: {args.type}")
    return 0


def cmd_interrupt(project_dir, args):
    state = mark_interrupted(project_dir, args.reason)
    print(f"Marked interrupted (stage={state['stage']})")
    return 0


def cmd_recover(project_dir, args):
    state = recover_execution(project_dir, note=args.note)
    print(f"Recovered execution (stage={state['stage']})")
    return 0


def build_parser():
    parser = argparse.ArgumentParser(description="Weekly lifecycle governance helper")
    sub = parser.add_subparsers(dest="command", required=True)

    status = sub.add_parser("status")
    status.set_defaults(func=cmd_status)

    new_week = sub.add_parser("new-week")
    new_week.add_argument("--week-id", default="")
    new_week.add_argument("--goal", default="")
    new_week.set_defaults(func=cmd_new_week)

    proposal = sub.add_parser("record-proposal")
    proposal.add_argument("--agent", required=True)
    proposal.add_argument("--summary", required=True)
    proposal.set_defaults(func=cmd_proposal)

    challenge = sub.add_parser("record-challenge")
    challenge.add_argument("--agent", required=True)
    challenge.add_argument("--summary", required=True)
    challenge.set_defaults(func=cmd_challenge)

    decision = sub.add_parser("owner-decision")
    decision.add_argument("--decision", required=True)
    decision.add_argument("--note", default="")
    decision.set_defaults(func=cmd_owner_decision)

    log_event = sub.add_parser("log-event")
    log_event.add_argument("--type", required=True)
    log_event.add_argument("--summary", default="")
    log_event.add_argument("--agent", default="")
    log_event.add_argument("--task", default="")
    log_event.set_defaults(func=cmd_log_event)

    interrupt = sub.add_parser("mark-interrupted")
    interrupt.add_argument("--reason", default="")
    interrupt.set_defaults(func=cmd_interrupt)

    recover = sub.add_parser("recover")
    recover.add_argument("--note", default="")
    recover.set_defaults(func=cmd_recover)

    return parser


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    parser = build_parser()
    args = parser.parse_args(argv)
    project_dir = _project_root()
    try:
        return args.func(project_dir, args)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
