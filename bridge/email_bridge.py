#!/usr/bin/env python3
from __future__ import annotations

import argparse
import email
import imaplib
import json
import os
import re
import select
import smtplib
import ssl
import sys
import time
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.utils import formatdate, make_msgid, parsedate_to_datetime
from html import unescape
from pathlib import Path
from typing import Any


THREAD_PREFIX = "[codex-thread:{thread_id}]"
DEFAULT_ENV_FILE = Path("~/.codex/email-bridge/.env").expanduser().resolve()


@dataclass
class EmailConfig:
    address: str
    username: str
    password: str
    default_to: str
    smtp_host: str
    smtp_port: int
    smtp_starttls: bool
    imap_host: str
    imap_port: int
    mailbox: str
    state_dir: Path


@dataclass
class ThreadState:
    thread_id: str
    to: str = ""
    subject: str = ""
    marker: str = ""
    last_seen_uid: int = 0
    known_message_ids: list[str] = field(default_factory=list)
    last_message_id: str = ""


def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()
    config = _load_config()

    if args.command == "send":
        result = send_email(
            config=config,
            to=args.to or config.default_to,
            subject=args.subject,
            body=_read_body(args.body, args.body_file),
            thread_id=args.thread_id,
        )
        print(json.dumps(result, indent=2))
        return 0

    if args.command == "fetch":
        result = fetch_replies(
            config=config,
            thread_id=args.thread_id,
            limit=args.limit,
            advance=not args.no_advance,
        )
        print(json.dumps(result, indent=2, default=str))
        return 0

    if args.command == "wait":
        result = wait_for_reply(
            config=config,
            thread_id=args.thread_id,
            poll_seconds=args.poll_seconds,
            timeout_seconds=args.timeout_seconds,
        )
        print(json.dumps(result, indent=2, default=str))
        return 0

    if args.command == "watch":
        for event in watch_replies(
            config=config,
            thread_id=args.thread_id,
            poll_seconds=args.poll_seconds,
            timeout_seconds=args.timeout_seconds,
            once=args.once,
        ):
            print(json.dumps(event, default=str), flush=True)
        return 0

    raise SystemExit(f"unsupported command: {args.command}")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Codex email bridge over SMTP/IMAP.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    send_parser = subparsers.add_parser("send", help="Send a new email or a threaded reply.")
    send_parser.add_argument("--to", default="", help="Recipient email address. Defaults to CODEX_EMAIL_TO.")
    send_parser.add_argument("--subject", required=True, help="Human-readable subject.")
    send_parser.add_argument("--body", default="", help="Inline body text.")
    send_parser.add_argument("--body-file", default="", help="Read body text from a file.")
    send_parser.add_argument("--thread-id", default="", help="Existing thread id. Omit to create a new thread.")

    fetch_parser = subparsers.add_parser("fetch", help="Fetch new replies for a thread.")
    fetch_parser.add_argument("--thread-id", required=True, help="Thread id returned by `send`.")
    fetch_parser.add_argument("--limit", type=int, default=10, help="Maximum matching replies to return.")
    fetch_parser.add_argument("--no-advance", action="store_true", help="Do not advance the saved cursor.")

    wait_parser = subparsers.add_parser("wait", help="Poll until a new reply arrives for a thread.")
    wait_parser.add_argument("--thread-id", required=True, help="Thread id returned by `send`.")
    wait_parser.add_argument("--poll-seconds", type=int, default=30, help="Polling interval.")
    wait_parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=120,
        help="Stop waiting after this many seconds. 0 means wait forever. Default 120.",
    )

    watch_parser = subparsers.add_parser("watch", help="Watch one email thread and emit reply events.")
    watch_parser.add_argument("--thread-id", required=True, help="Thread id returned by `send`.")
    watch_parser.add_argument("--poll-seconds", type=int, default=30, help="Fallback polling interval.")
    watch_parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=0,
        help="Stop watching after this many seconds. 0 means watch forever.",
    )
    watch_parser.add_argument("--once", action="store_true", help="Exit after the first reply event or timeout event.")
    return parser


def _load_config() -> EmailConfig:
    _load_local_env(DEFAULT_ENV_FILE)
    address = _require_env("CODEX_EMAIL_ADDRESS")
    password = _require_env("CODEX_EMAIL_PASSWORD")
    default_to = os.getenv("CODEX_EMAIL_TO", "").strip()
    smtp_host = os.getenv("CODEX_EMAIL_SMTP_HOST", "smtp.gmail.com").strip()
    smtp_port = int(os.getenv("CODEX_EMAIL_SMTP_PORT", "465"))
    smtp_starttls = os.getenv("CODEX_EMAIL_SMTP_STARTTLS", "false").strip().lower() == "true"
    imap_host = os.getenv("CODEX_EMAIL_IMAP_HOST", "imap.gmail.com").strip()
    imap_port = int(os.getenv("CODEX_EMAIL_IMAP_PORT", "993"))
    mailbox = os.getenv("CODEX_EMAIL_IMAP_MAILBOX", "INBOX").strip() or "INBOX"
    state_dir = Path(os.getenv("CODEX_EMAIL_STATE_DIR", "~/.codex/email-bridge/state")).expanduser().resolve()
    state_dir.mkdir(parents=True, exist_ok=True)
    username = os.getenv("CODEX_EMAIL_USERNAME", address).strip() or address
    return EmailConfig(
        address=address,
        username=username,
        password=password,
        default_to=default_to,
        smtp_host=smtp_host,
        smtp_port=smtp_port,
        smtp_starttls=smtp_starttls,
        imap_host=imap_host,
        imap_port=imap_port,
        mailbox=mailbox,
        state_dir=state_dir,
    )


def _load_local_env(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        if key and key not in os.environ:
            os.environ[key] = value


def send_email(*, config: EmailConfig, to: str, subject: str, body: str, thread_id: str = "") -> dict[str, Any]:
    if not to:
        raise SystemExit("Recipient is required. Pass --to or set CODEX_EMAIL_TO.")

    state = _load_state(config, thread_id or _new_thread_id())
    state.to = to
    base_subject = subject.strip()
    state.subject = base_subject
    state.marker = THREAD_PREFIX.format(thread_id=state.thread_id)

    msg = EmailMessage()
    msg["From"] = config.address
    msg["To"] = to
    msg["Date"] = formatdate(localtime=True)
    msg["Subject"] = _thread_subject(base_subject, state.thread_id)
    message_id = make_msgid(domain=config.address.split("@", 1)[-1])
    msg["Message-ID"] = message_id
    if state.last_message_id:
        msg["In-Reply-To"] = state.last_message_id
        msg["References"] = " ".join(_unique_ids(state.known_message_ids + [state.last_message_id]))
    msg.set_content(body)

    if config.smtp_starttls:
        with smtplib.SMTP(config.smtp_host, config.smtp_port, timeout=60) as smtp:
            smtp.ehlo()
            smtp.starttls(context=ssl.create_default_context())
            smtp.login(config.username, config.password)
            smtp.send_message(msg)
    else:
        with smtplib.SMTP_SSL(config.smtp_host, config.smtp_port, timeout=60, context=ssl.create_default_context()) as smtp:
            smtp.login(config.username, config.password)
            smtp.send_message(msg)

    state.last_message_id = message_id
    state.known_message_ids = _unique_ids(state.known_message_ids + [message_id])
    # Seed cursor to current mailbox tip so fetch/wait starts from new mail only.
    try:
        uidnext = _mailbox_uidnext(config)
        if uidnext > 1:
            state.last_seen_uid = max(state.last_seen_uid, uidnext - 1)
    except Exception:
        pass
    _save_state(config, state)
    return {
        "thread_id": state.thread_id,
        "subject": msg["Subject"],
        "message_id": message_id,
        "to": to,
        "state_file": str(_state_path(config, state.thread_id)),
    }


def fetch_replies(*, config: EmailConfig, thread_id: str, limit: int = 10, advance: bool = True) -> dict[str, Any]:
    state = _load_state(config, thread_id)
    state.marker = state.marker or THREAD_PREFIX.format(thread_id=thread_id)
    start_uid = max(1, state.last_seen_uid + 1)

    with _selected_imap_connection(config, timeout=60) as imap:
        replies, next_scan_uid = _scan_matching_replies(
            imap=imap,
            state=state,
            start_uid=start_uid,
            limit=max(1, limit),
        )

    last_seen_uid = state.last_seen_uid
    if advance:
        last_seen_uid = max(last_seen_uid, next_scan_uid - 1)
        _persist_thread_state(config=config, state=state, last_seen_uid=last_seen_uid, force=bool(replies))

    return _reply_batch_result(
        thread_id=thread_id,
        replies=replies,
        last_seen_uid=last_seen_uid,
    )


def wait_for_reply(
    *,
    config: EmailConfig,
    thread_id: str,
    poll_seconds: int = 30,
    timeout_seconds: int = 120,
) -> dict[str, Any]:
    for event in watch_replies(
        config=config,
        thread_id=thread_id,
        poll_seconds=poll_seconds,
        timeout_seconds=timeout_seconds,
        once=True,
    ):
        return _event_to_wait_result(event)
    return _timed_out_result(thread_id)


def watch_replies(
    *,
    config: EmailConfig,
    thread_id: str,
    poll_seconds: int = 30,
    timeout_seconds: int = 0,
    once: bool = False,
):
    started_at = time.monotonic()
    state = _load_state(config, thread_id)
    state.marker = state.marker or THREAD_PREFIX.format(thread_id=thread_id)
    next_scan_uid = max(1, state.last_seen_uid + 1)
    use_idle = True

    while True:
        remaining_seconds = _remaining_timeout_seconds(started_at=started_at, timeout_seconds=timeout_seconds)
        if remaining_seconds is not None and remaining_seconds <= 0:
            yield _timeout_event(thread_id)
            return

        try:
            if use_idle:
                replies, next_scan_uid = _watch_step_with_idle(
                    config=config,
                    state=state,
                    start_uid=next_scan_uid,
                    remaining_seconds=remaining_seconds,
                )
            else:
                replies, next_scan_uid = _watch_step_with_polling(
                    config=config,
                    state=state,
                    start_uid=next_scan_uid,
                    poll_seconds=poll_seconds,
                    remaining_seconds=remaining_seconds,
                )
        except Exception:
            if use_idle:
                use_idle = False
                continue
            raise

        last_seen_uid = max(state.last_seen_uid, next_scan_uid - 1)
        _persist_thread_state(config=config, state=state, last_seen_uid=last_seen_uid, force=bool(replies))

        for reply in replies:
            yield _reply_event(thread_id=thread_id, reply=reply, last_seen_uid=last_seen_uid)
            if once:
                return


def _remaining_timeout_seconds(*, started_at: float, timeout_seconds: int) -> int | None:
    if timeout_seconds <= 0:
        return None
    elapsed_seconds = int(time.monotonic() - started_at)
    return max(0, timeout_seconds - elapsed_seconds)


def _timed_out_result(thread_id: str) -> dict[str, Any]:
    return {
        "thread_id": thread_id,
        "reply_count": 0,
        "timed_out": True,
        "replies": [],
    }


def _reply_event(*, thread_id: str, reply: dict[str, Any], last_seen_uid: int) -> dict[str, Any]:
    return {
        "event": "reply",
        "thread_id": thread_id,
        "last_seen_uid": last_seen_uid,
        "reply": reply,
    }


def _timeout_event(thread_id: str) -> dict[str, Any]:
    return {
        "event": "timeout",
        "thread_id": thread_id,
        "timed_out": True,
    }


def _event_to_wait_result(event: dict[str, Any]) -> dict[str, Any]:
    if event.get("event") != "reply":
        return _timed_out_result(str(event.get("thread_id", "")))

    thread_id = str(event.get("thread_id", ""))
    last_seen_uid = int(event.get("last_seen_uid", 0) or 0)
    reply = dict(event.get("reply") or {})
    return _reply_batch_result(
        thread_id=thread_id,
        replies=[reply],
        last_seen_uid=last_seen_uid,
    )


def _reply_batch_result(*, thread_id: str, replies: list[dict[str, Any]], last_seen_uid: int) -> dict[str, Any]:
    return {
        "thread_id": thread_id,
        "reply_count": len(replies),
        "last_seen_uid": last_seen_uid,
        "replies": replies,
    }


def _idle_window_seconds(remaining_seconds: int | None) -> int:
    if remaining_seconds is None:
        return 29 * 60
    return max(1, min(remaining_seconds, 29 * 60))


@contextmanager
def _selected_imap_connection(config: EmailConfig, *, timeout: int = 60):
    with imaplib.IMAP4_SSL(config.imap_host, config.imap_port, timeout=timeout) as imap:
        imap.login(config.username, config.password)
        status, _ = imap.select(config.mailbox)
        if status != "OK":
            raise RuntimeError(f"unable to select mailbox {config.mailbox}")
        yield imap


def _mailbox_uidnext(config: EmailConfig) -> int:
    with _selected_imap_connection(config, timeout=10) as imap:
        status, data = imap.status(config.mailbox, "(UIDNEXT)")
        if status != "OK":
            raise RuntimeError(f"unable to read UIDNEXT for mailbox {config.mailbox}")
        payload = (data[0] or b"").decode("utf-8", errors="ignore")
        match = re.search(r"UIDNEXT\s+(\d+)", payload, flags=re.IGNORECASE)
        if not match:
            raise RuntimeError("UIDNEXT not found in IMAP STATUS response")
        return int(match.group(1))


def _watch_step_with_idle(
    *,
    config: EmailConfig,
    state: ThreadState,
    start_uid: int,
    remaining_seconds: int | None,
) -> tuple[list[dict[str, Any]], int]:
    with _selected_imap_connection(config, timeout=60) as imap:
        replies, next_scan_uid = _scan_matching_replies(
            imap=imap,
            state=state,
            start_uid=start_uid,
            limit=None,
        )
        if replies:
            return replies, next_scan_uid

        _idle_until_mailbox_activity(imap, timeout_seconds=_idle_window_seconds(remaining_seconds))

        return _scan_matching_replies(
            imap=imap,
            state=state,
            start_uid=next_scan_uid,
            limit=None,
        )


def _watch_step_with_polling(
    *,
    config: EmailConfig,
    state: ThreadState,
    start_uid: int,
    poll_seconds: int,
    remaining_seconds: int | None,
) -> tuple[list[dict[str, Any]], int]:
    with _selected_imap_connection(config, timeout=60) as imap:
        replies, next_scan_uid = _scan_matching_replies(
            imap=imap,
            state=state,
            start_uid=start_uid,
            limit=None,
        )

    if replies:
        return replies, next_scan_uid

    sleep_seconds = max(1, poll_seconds)
    if remaining_seconds is not None:
        sleep_seconds = min(sleep_seconds, max(1, remaining_seconds))
    time.sleep(sleep_seconds)
    return [], next_scan_uid


def _scan_matching_replies(
    *,
    imap,
    state: ThreadState,
    start_uid: int,
    limit: int | None,
) -> tuple[list[dict[str, Any]], int]:
    marker = state.marker or THREAD_PREFIX.format(thread_id=state.thread_id)
    search_start_uid = max(1, start_uid)
    status, data = imap.uid("search", None, "UID", f"{search_start_uid}:*")
    if status != "OK":
        status, data = imap.uid("search", None, "ALL")
    if status != "OK":
        raise RuntimeError("imap search failed")

    uids = [int(item) for item in (data[0] or b"").split() if item.strip()]
    replies: list[dict[str, Any]] = []
    highest_seen_uid = search_start_uid - 1

    for uid in uids:
        if uid < search_start_uid:
            continue
        highest_seen_uid = max(highest_seen_uid, uid)
        status, fetched = imap.uid("fetch", str(uid), "(RFC822)")
        if status != "OK" or not fetched or not fetched[0]:
            continue
        raw = fetched[0][1]
        if not raw:
            continue
        message = email.message_from_bytes(raw)
        parsed = _parse_message(message, uid=uid)
        if not _matches_thread(parsed, marker=marker, known_message_ids=state.known_message_ids):
            continue
        replies.append(parsed)
        if parsed["message_id"]:
            state.known_message_ids = _unique_ids(state.known_message_ids + [parsed["message_id"]])
            state.last_message_id = parsed["message_id"]

    if limit is not None and len(replies) > limit:
        replies = replies[-limit:]

    next_scan_uid = max(search_start_uid, highest_seen_uid + 1)
    return replies, next_scan_uid


def _persist_thread_state(
    *,
    config: EmailConfig,
    state: ThreadState,
    last_seen_uid: int,
    force: bool = False,
) -> None:
    should_save = force or last_seen_uid > state.last_seen_uid
    state.last_seen_uid = max(state.last_seen_uid, last_seen_uid)
    if should_save:
        _save_state(config, state)


def _idle_until_mailbox_activity(imap: imaplib.IMAP4_SSL, *, timeout_seconds: int) -> None:
    sock = getattr(imap, "sock", None)
    if sock is None:
        raise RuntimeError("imap idle socket unavailable")

    tag = imap._new_tag()
    imap.send(tag + b" IDLE\r\n")
    continuation = imap._get_line()
    if not continuation.startswith(b"+"):
        raise RuntimeError(f"imap idle rejected: {continuation!r}")

    deadline = time.monotonic() + max(1, timeout_seconds)

    try:
        while True:
            wait_seconds = max(0.0, deadline - time.monotonic())
            if wait_seconds == 0:
                return

            readable, _, _ = select.select([sock], [], [], wait_seconds)
            if not readable:
                return

            line = imap._get_line()
            upper_line = line.upper()

            if upper_line.startswith(b"* BYE"):
                raise RuntimeError(f"imap idle terminated by server: {line!r}")

            if upper_line.startswith(b"* ") and (b" EXISTS" in upper_line or b" RECENT" in upper_line):
                return
    finally:
        _finish_idle(imap, tag)


def _finish_idle(imap: imaplib.IMAP4_SSL, tag: bytes) -> None:
    sock = getattr(imap, "sock", None)
    if sock is None:
        raise RuntimeError("imap idle socket unavailable")

    imap.send(b"DONE\r\n")
    deadline = time.monotonic() + 10

    while True:
        wait_seconds = max(0.0, deadline - time.monotonic())
        if wait_seconds == 0:
            raise RuntimeError("imap idle did not terminate cleanly")

        readable, _, _ = select.select([sock], [], [], wait_seconds)
        if not readable:
            continue

        line = imap._get_line()
        upper_line = line.upper()

        if upper_line.startswith(b"* BYE"):
            raise RuntimeError(f"imap idle terminated by server: {line!r}")

        if line.startswith(tag + b" "):
            if b" OK" not in upper_line:
                raise RuntimeError(f"imap idle finished with non-OK response: {line!r}")
            return


def _parse_message(message: email.message.Message, *, uid: int) -> dict[str, Any]:
    subject = _decode_header_value(message.get("Subject", ""))
    from_value = _decode_header_value(message.get("From", ""))
    message_id = (message.get("Message-ID", "") or "").strip()
    in_reply_to = (message.get("In-Reply-To", "") or "").strip()
    references = (message.get("References", "") or "").strip()
    date_value = message.get("Date", "")
    date_iso = ""
    if date_value:
        try:
            date_iso = parsedate_to_datetime(date_value).isoformat()
        except Exception:
            date_iso = date_value
    body = _extract_body_text(message)
    return {
        "uid": uid,
        "subject": subject,
        "from": from_value,
        "message_id": message_id,
        "in_reply_to": in_reply_to,
        "references": references,
        "date": date_iso,
        "body": body,
    }


def _extract_body_text(message: email.message.Message) -> str:
    if message.is_multipart():
        for part in message.walk():
            content_type = part.get_content_type()
            disposition = (part.get("Content-Disposition", "") or "").lower()
            if "attachment" in disposition:
                continue
            payload = part.get_payload(decode=True) or b""
            charset = part.get_content_charset() or "utf-8"
            text = payload.decode(charset, errors="replace").strip()
            if content_type == "text/plain" and text:
                return text
        for part in message.walk():
            if part.get_content_type() == "text/html":
                payload = part.get_payload(decode=True) or b""
                charset = part.get_content_charset() or "utf-8"
                return _html_to_text(payload.decode(charset, errors="replace"))
        return ""

    payload = message.get_payload(decode=True) or b""
    charset = message.get_content_charset() or "utf-8"
    text = payload.decode(charset, errors="replace")
    if message.get_content_type() == "text/html":
        return _html_to_text(text)
    return text.strip()


def _html_to_text(html: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?>.*?</\\1>", " ", html)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    return " ".join(unescape(text).split())


def _matches_thread(message: dict[str, Any], *, marker: str, known_message_ids: list[str]) -> bool:
    subject = message["subject"]
    if marker in subject:
        return True
    refs_blob = " ".join([message["in_reply_to"], message["references"]]).strip()
    return any(message_id and message_id in refs_blob for message_id in known_message_ids)


def _decode_header_value(value: str) -> str:
    try:
        return str(make_header(decode_header(value))).strip()
    except Exception:
        return value.strip()


def _read_body(body: str, body_file: str) -> str:
    if body_file:
        return Path(body_file).read_text(encoding="utf-8")
    if body:
        return body
    if not sys.stdin.isatty():
        return sys.stdin.read()
    raise SystemExit("Body is required. Pass --body, --body-file, or pipe text on stdin.")


def _thread_subject(subject: str, thread_id: str) -> str:
    return f"{THREAD_PREFIX.format(thread_id=thread_id)} {subject.strip()}".strip()


def _new_thread_id() -> str:
    return uuid.uuid4().hex[:12]


def _state_path(config: EmailConfig, thread_id: str) -> Path:
    return config.state_dir / f"{thread_id}.json"


def _load_state(config: EmailConfig, thread_id: str) -> ThreadState:
    path = _state_path(config, thread_id)
    if not path.exists():
        return ThreadState(thread_id=thread_id, marker=THREAD_PREFIX.format(thread_id=thread_id))
    payload = json.loads(path.read_text(encoding="utf-8"))
    return ThreadState(
        thread_id=payload.get("thread_id", thread_id),
        to=payload.get("to", ""),
        subject=payload.get("subject", ""),
        marker=payload.get("marker", THREAD_PREFIX.format(thread_id=thread_id)),
        last_seen_uid=int(payload.get("last_seen_uid", 0) or 0),
        known_message_ids=[str(item).strip() for item in payload.get("known_message_ids", []) if str(item).strip()],
        last_message_id=payload.get("last_message_id", ""),
    )


def _save_state(config: EmailConfig, state: ThreadState) -> None:
    path = _state_path(config, state.thread_id)
    path.write_text(json.dumps(asdict(state), indent=2), encoding="utf-8")


def _unique_ids(values: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        cleaned = value.strip()
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        ordered.append(cleaned)
    return ordered


def _require_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise SystemExit(f"Missing required env var: {name}")
    return value


if __name__ == "__main__":
    raise SystemExit(main())
