#!/usr/bin/env python3
"""Import article pages from the pinned 1C syntax help archive into SQLite."""

from __future__ import annotations

import argparse
import hashlib
import html.parser
import io
import json
import posixpath
import re
import sqlite3
import stat
import sys
import time
import urllib.parse
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


SOURCE_SHA256 = "5bdf0b3ed89932572c012faddc4d05ebfa2986595cf2849b6eb6e5e65a9a4d48"
SOURCE_FILE_LENGTH = 40_744_845
SOURCE_ZIP_OFFSET = 1656
SOURCE_ZIP_LENGTH = 38_375_914
BASELINE_DB_SHA256 = "bf14382e6542ce18b1a7c195e325365cf91d855cbc85a70a8fa4259534ce4c85"
BASELINE_ROW_COUNT = 2673
BASELINE_ROWS_SHA256 = "4ba3377fc68db29d11ccf247f6aacd764179e4fbde5777c722849e83bf279158"
EXPECTED_ARCHIVE_PAGE_COUNT = 24_784
EXPECTED_ADDED_PAGE_COUNT = 22_114
EXPECTED_ORPHAN_PAGE_COUNT = 48
MAX_HTML_PAGE_BYTES = 4 * 1024 * 1024
MAX_TOTAL_HTML_BYTES = 256 * 1024 * 1024


@dataclass(frozen=True)
class ParsedArticle:
    title: str
    content: str
    hrefs: tuple[str, ...]
    marked_content: str
    links: tuple[tuple[int, str], ...]


@dataclass
class _Capture:
    target: str
    chunks: list[str]


@dataclass
class _Frame:
    tag: str
    hidden: bool
    capture: _Capture | None = None
    chapter: bool = False
    link_marker: int | None = None


class _ArticleParser(html.parser.HTMLParser):
    _BLOCK_TAGS = {
        "address", "article", "aside", "blockquote", "body", "dd", "details", "div", "dl",
        "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4",
        "h5", "h6", "header", "hr", "li", "main", "ol", "p", "pre", "section", "table",
        "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
    }
    _VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
    _HIDDEN_TAGS = {"head", "script", "style", "noscript"}
    _TITLE_CLASSES = {"V8SH_heading", "V8SH_pagetitle", "V8SH_title"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._frames: list[_Frame] = []
        self._text: list[str] = []
        self._captures: dict[str, list[str]] = defaultdict(list)
        self.hrefs: list[str] = []
        self.links: list[tuple[int, str]] = []

    @staticmethod
    def _link_start(marker: int) -> str:
        return f"\ue000SHL{marker}\ue001"

    @staticmethod
    def _link_end(marker: int) -> str:
        return f"\ue002SHL{marker}\ue003"

    def _hidden(self) -> bool:
        return any(frame.hidden for frame in self._frames)

    def _separator(self, value: str = "\n") -> None:
        self._text.append(value)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        attributes = {key.lower(): value for key, value in attrs}
        class_names = set((attributes.get("class") or "").split())
        hidden = self._hidden() or tag in self._HIDDEN_TAGS
        chapter = "V8SH_chapter" in class_names
        if not hidden and chapter:
            self._separator("\n\n")
        elif not hidden and tag in self._BLOCK_TAGS:
            self._separator("\n")
        elif not hidden and tag in {"td", "th"}:
            self._separator(" ")
        if not hidden and tag in {"br", "hr"}:
            self._separator("\n")

        link_marker: int | None = None
        if not hidden and tag == "a":
            href = attributes.get("href")
            if href:
                self.hrefs.append(href)
                link_marker = len(self.links)
                self.links.append((link_marker, href))
                self._text.append(self._link_start(link_marker))

        capture: _Capture | None = None
        target = next((name for name in ("V8SH_heading", "V8SH_pagetitle", "V8SH_title") if name in class_names), None)
        if target and not hidden:
            capture = _Capture(target, [])
        elif tag == "title":
            capture = _Capture("html_title", [])

        if tag not in self._VOID_TAGS:
            self._frames.append(_Frame(tag, hidden, capture, chapter, link_marker))
        elif capture:
            self._captures[capture.target].append("")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in self._VOID_TAGS:
            return
        matching_index = next((index for index in range(len(self._frames) - 1, -1, -1)
                               if self._frames[index].tag == tag), None)
        if matching_index is None:
            return
        matching_frame = self._frames[matching_index]
        if not self._hidden():
            if matching_frame.chapter:
                self._separator("\n\n")
            elif tag in self._BLOCK_TAGS:
                self._separator("\n")
        closing = self._frames[matching_index:]
        del self._frames[matching_index:]
        for frame in reversed(closing):
            if frame.link_marker is not None:
                self._text.append(self._link_end(frame.link_marker))
            if frame.capture:
                self._captures[frame.capture.target].append("".join(frame.capture.chunks))

    def handle_data(self, data: str) -> None:
        hidden = self._hidden()
        if not hidden:
            self._text.append(data)
        for frame in self._frames:
            if frame.capture and (not hidden or frame.capture.target == "html_title"):
                frame.capture.chunks.append(data)

    def finish(self) -> ParsedArticle:
        self.close()
        while self._frames:
            frame = self._frames.pop()
            if frame.link_marker is not None:
                self._text.append(self._link_end(frame.link_marker))
            if frame.capture:
                self._captures[frame.capture.target].append("".join(frame.capture.chunks))

        title = ""
        for key in ("V8SH_heading", "V8SH_pagetitle", "V8SH_title", "html_title"):
            candidates = [normalize_inline(value) for value in self._captures.get(key, [])]
            title = next((value for value in candidates if value), "")
            if title:
                break
        marked_content = normalize_article_text("".join(self._text))
        content = normalize_article_text(re.sub(r"\ue000SHL\d+\ue001|\ue002SHL\d+\ue003", "", marked_content))
        return ParsedArticle(
            title=title,
            content=content,
            hrefs=tuple(self.hrefs),
            marked_content=marked_content,
            links=tuple(self.links),
        )


def normalize_inline(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("\ufeff", " ").replace("\xa0", " ")).strip()


def normalize_article_text(value: str) -> str:
    value = value.replace("\ufeff", " ").replace("\xa0", " ").replace("\r\n", "\n").replace("\r", "\n")
    value = re.sub(r"[\t\f\v ]+", " ", value)
    value = re.sub(r" *\n *", "\n", value)
    lines: list[str] = []
    for line in value.split("\n"):
        normalized = line.strip()
        if normalized or (lines and lines[-1]):
            lines.append(normalized)
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def parse_article(path: str, raw_html: bytes) -> ParsedArticle:
    """Extract the most specific heading and readable body text from one UTF-8 page."""
    try:
        source = raw_html.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValueError(f"HTML page is not valid UTF-8: {path}") from error
    parser = _ArticleParser()
    parser.feed(source)
    parsed = parser.finish()
    if not parsed.title:
        parsed = ParsedArticle(
            title=Path(path).stem, content=parsed.content, hrefs=parsed.hrefs,
            marked_content=parsed.marked_content, links=parsed.links,
        )
    if not parsed.content:
        parsed = ParsedArticle(
            title=parsed.title, content=parsed.title, hrefs=parsed.hrefs,
            marked_content=parsed.title, links=parsed.links,
        )
    return parsed


def resolve_internal_href(page_path: str, href: str) -> str | None:
    """Resolve a context-help href to a safe path relative to the ZIP's objects/ directory."""
    href = href.strip().replace("\\", "/")
    if not href:
        return None
    parsed = urllib.parse.urlsplit(href)
    path = urllib.parse.unquote(parsed.path)
    if parsed.scheme:
        if parsed.scheme.lower() != "v8help" or parsed.netloc.lower() != "syntaxhelpercontext":
            return None
        if path.startswith("/SyntaxHelperContext/"):
            path = path[len("/SyntaxHelperContext/"):]
        if path.startswith("/objects/"):
            path = path[len("/objects/"):]
        elif path.startswith("objects/"):
            path = path[len("objects/"):]
        else:
            return None
    elif path.startswith("/objects/"):
        path = path[len("/objects/"):]
    elif path.startswith("/"):
        return None
    elif not path:
        return None
    else:
        path = posixpath.join(posixpath.dirname(page_path), path)

    normalized = posixpath.normpath(path)
    if normalized in {"", ".", ".."} or normalized.startswith("../") or normalized.startswith("/"):
        return None
    if not normalized.lower().endswith(".html"):
        return None
    return normalized


def object_html_infos(archive: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    """Return validated HTML members below objects/, without extracting archive files."""
    result: dict[str, zipfile.ZipInfo] = {}
    total_size = 0
    for info in archive.infolist():
        name = info.filename
        if not name.startswith("objects/") or not name.lower().endswith(".html"):
            continue
        if name.startswith("/") or "\\" in name:
            raise ValueError(f"Unsafe ZIP member path: {name!r}")
        parts = name.split("/")
        if any(part in {"", ".", ".."} for part in parts) or len(parts) < 2:
            raise ValueError(f"Unsafe ZIP member path: {name!r}")
        relative_path = name[len("objects/"):]
        mode = info.external_attr >> 16
        if stat.S_ISLNK(mode):
            raise ValueError(f"ZIP member is a symbolic link: {name!r}")
        if info.flag_bits & 0x1:
            raise ValueError(f"Encrypted ZIP member is not supported: {name!r}")
        if info.file_size > MAX_HTML_PAGE_BYTES:
            raise ValueError(f"HTML page exceeds the size limit: {name!r}")
        total_size += info.file_size
        if total_size > MAX_TOTAL_HTML_BYTES:
            raise ValueError("HTML members exceed the total uncompressed size limit.")
        if relative_path in result:
            raise ValueError(f"Duplicate ZIP article path: {relative_path!r}")
        result[relative_path] = info
    return result


def open_pinned_hbk(hbk_path: Path) -> tuple[io.BytesIO, zipfile.ZipFile]:
    """Verify the pinned source and open only its fixed, embedded ZIP byte range."""
    data = hbk_path.read_bytes()
    actual_hash = hashlib.sha256(data).hexdigest()
    if actual_hash != SOURCE_SHA256:
        raise ValueError(f"Unexpected Hbk SHA-256: {actual_hash}")
    if len(data) != SOURCE_FILE_LENGTH:
        raise ValueError(f"Unexpected Hbk length: expected {SOURCE_FILE_LENGTH}, got {len(data)}")
    end = SOURCE_ZIP_OFFSET + SOURCE_ZIP_LENGTH
    zip_data = data[SOURCE_ZIP_OFFSET:end]
    if not zip_data.startswith(b"PK\x03\x04"):
        raise ValueError("The pinned Hbk ZIP range has an invalid signature.")
    stream = io.BytesIO(zip_data)
    try:
        archive = zipfile.ZipFile(stream, "r")
    except zipfile.BadZipFile as error:
        stream.close()
        raise ValueError("The embedded Hbk range is not a valid ZIP archive.") from error
    return stream, archive


def read_nodes(connection: sqlite3.Connection) -> list[tuple[int, int | None, str, str, str]]:
    columns = [row[1] for row in connection.execute("PRAGMA table_info(nodes)")]
    expected = ["id", "parent_id", "name", "path", "content"]
    if columns != expected:
        raise ValueError(f"Unexpected nodes schema: {columns!r}")
    rows = connection.execute(
        "SELECT id, parent_id, name, path, content FROM nodes ORDER BY id"
    ).fetchall()
    return [tuple(row) for row in rows]  # type: ignore[return-value]


def logical_rows_sha256(rows: Iterable[tuple[object, ...]]) -> str:
    payload = json.dumps(list(rows), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def validate_base_rows(rows: list[tuple[int, int | None, str, str, str]]) -> list[tuple[int, int | None, str, str, str]]:
    if len(rows) < BASELINE_ROW_COUNT:
        raise ValueError(f"The database has only {len(rows)} rows; expected at least {BASELINE_ROW_COUNT}.")
    base_rows = rows[:BASELINE_ROW_COUNT]
    if [row[0] for row in base_rows] != list(range(1, BASELINE_ROW_COUNT + 1)):
        raise ValueError("The baseline node IDs are not the expected 1..2673 range.")
    if logical_rows_sha256(base_rows) != BASELINE_ROWS_SHA256:
        raise ValueError("The logical fields of baseline rows 1..2673 do not match the pinned database.")
    return base_rows


def _base_parent_by_target(
    base_rows: list[tuple[int, int | None, str, str, str]],
    archive: zipfile.ZipFile,
    members: dict[str, zipfile.ZipInfo],
    missing_paths: set[str],
) -> dict[str, int]:
    parents: dict[str, int] = {}
    for node_id, _parent_id, _name, page_path, _content in base_rows:
        info = members.get(page_path)
        if info is None:
            raise ValueError(f"Baseline node path is absent from the pinned archive: {page_path!r}")
        article = parse_article(page_path, archive.read(info))
        for href in article.hrefs:
            target = resolve_internal_href(page_path, href)
            if target in missing_paths and target not in parents:
                parents[target] = node_id
    return parents


def expected_added_rows(
    base_rows: list[tuple[int, int | None, str, str, str]],
    archive: zipfile.ZipFile,
    members: dict[str, zipfile.ZipInfo],
) -> tuple[list[tuple[int, int | None, str, str, str]], int]:
    """Build the deterministic appended rows from a source archive and original rows."""
    base_paths = {row[3] for row in base_rows}
    source_paths = set(members)
    absent_base_paths = base_paths - source_paths
    if absent_base_paths:
        sample = sorted(absent_base_paths)[:5]
        raise ValueError(f"Baseline paths are absent from the pinned archive: {sample!r}")
    missing_paths = source_paths - base_paths
    parent_by_target = _base_parent_by_target(base_rows, archive, members, missing_paths)
    orphan_count = len(missing_paths - parent_by_target.keys())

    first_id = base_rows[-1][0] + 1
    appended: list[tuple[int, int | None, str, str, str]] = []
    for offset, page_path in enumerate(sorted(missing_paths)):
        article = parse_article(page_path, archive.read(members[page_path]))
        appended.append((first_id + offset, parent_by_target.get(page_path), article.title, page_path, article.content))
    return appended, orphan_count


def _escape_markdown_link_label(value: str) -> str:
    return re.sub(r"([\\\[\]])", r"\\\1", normalize_inline(value))


def linked_markdown(article: ParsedArticle, page_path: str, node_id_by_path: dict[str, int]) -> str:
    """Replace marked visible anchors with links to known article IDs only."""
    markdown = article.marked_content
    for marker, href in article.links:
        start = f"\ue000SHL{marker}\ue001"
        end = f"\ue002SHL{marker}\ue003"
        start_index = markdown.find(start)
        end_index = markdown.find(end, start_index + len(start)) if start_index >= 0 else -1
        if start_index < 0 or end_index < 0:
            continue
        label = markdown[start_index + len(start):end_index]
        target_path = resolve_internal_href(page_path, href)
        target_id = node_id_by_path.get(target_path) if target_path is not None else None
        visible_label = _escape_markdown_link_label(label)
        replacement = (
            f"[{visible_label}](bsl-help:syntax:{target_id})"
            if target_id is not None and visible_label
            else visible_label
        )
        markdown = markdown[:start_index] + replacement + markdown[end_index + len(end):]
    return normalize_article_text(re.sub(r"\ue000SHL\d+\ue001|\ue002SHL\d+\ue003", "", markdown))


def expected_article_markdown_rows(
    rows: list[tuple[int, int | None, str, str, str]],
    archive: zipfile.ZipFile,
    members: dict[str, zipfile.ZipInfo],
) -> list[tuple[int, str]]:
    node_id_by_path = {row[3]: row[0] for row in rows}
    rendered: list[tuple[int, str]] = []
    for node_id, _parent_id, _name, page_path, _content in rows:
        info = members.get(page_path)
        if info is None:
            raise ValueError(f"Article path is absent from the pinned archive: {page_path!r}")
        article = parse_article(page_path, archive.read(info))
        markdown = linked_markdown(article, page_path, node_id_by_path)
        if "bsl-help:syntax:" in markdown:
            rendered.append((node_id, markdown))
    return rendered


def ensure_article_markdown_table(
    connection: sqlite3.Connection,
    rows: list[tuple[int, int | None, str, str, str]],
    archive: zipfile.ZipFile,
    members: dict[str, zipfile.ZipInfo],
) -> bool:
    """Create missing link content for an older enriched DB, otherwise verify it."""
    expected = expected_article_markdown_rows(rows, archive, members)
    table_exists = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'article_markdown'"
    ).fetchone() is not None
    if not table_exists:
        connection.execute(
            "CREATE TABLE article_markdown (node_id INTEGER PRIMARY KEY, markdown TEXT NOT NULL, "
            "FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE)"
        )
        connection.executemany("INSERT INTO article_markdown (node_id, markdown) VALUES (?, ?)", expected)
        return True
    actual = connection.execute("SELECT node_id, markdown FROM article_markdown ORDER BY node_id").fetchall()
    if actual != expected:
        raise ValueError("The database article links do not match the pinned source archive.")
    return False


def validate_hierarchy(rows: list[tuple[int, int | None, str, str, str]]) -> None:
    parent_by_id = {row[0]: row[1] for row in rows}
    for node_id, parent_id in parent_by_id.items():
        if parent_id is not None and parent_id not in parent_by_id:
            raise ValueError(f"Node {node_id} references missing parent {parent_id}.")
    finished: set[int] = set()
    for start_id in parent_by_id:
        chain: set[int] = set()
        node_id: int | None = start_id
        while node_id is not None and node_id not in finished:
            if node_id in chain:
                raise ValueError(f"Hierarchy cycle found at node {node_id}.")
            chain.add(node_id)
            node_id = parent_by_id[node_id]
        finished.update(chain)


def append_articles(
    connection: sqlite3.Connection,
    base_rows: list[tuple[int, int | None, str, str, str]],
    archive: zipfile.ZipFile,
    *,
    enforce_pinned_counts: bool = True,
) -> tuple[int, int, int]:
    """Append missing source pages transactionally; return added, linked, orphan counts."""
    members = object_html_infos(archive)
    if enforce_pinned_counts and len(members) != EXPECTED_ARCHIVE_PAGE_COUNT:
        raise ValueError(f"Unexpected archive HTML page count: {len(members)}")
    additions, orphan_count = expected_added_rows(base_rows, archive, members)
    if enforce_pinned_counts and len(additions) != EXPECTED_ADDED_PAGE_COUNT:
        raise ValueError(f"Unexpected number of missing paths: {len(additions)}")
    if enforce_pinned_counts and orphan_count != EXPECTED_ORPHAN_PAGE_COUNT:
        raise ValueError(f"Unexpected orphan page count: {orphan_count}")

    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.executemany(
            "INSERT INTO nodes (id, parent_id, name, path, content) VALUES (?, ?, ?, ?, ?)",
            additions,
        )
        rows_after = read_nodes(connection)
        if rows_after[:len(base_rows)] != base_rows:
            raise ValueError("Appending articles changed one or more baseline rows.")
        if rows_after[len(base_rows):] != additions:
            raise ValueError("The appended article rows do not match the deterministic import plan.")
        ensure_article_markdown_table(connection, rows_after, archive, members)
        validate_hierarchy(rows_after)
        integrity = connection.execute("PRAGMA integrity_check").fetchone()
        if not integrity or integrity[0] != "ok":
            raise ValueError(f"SQLite integrity check failed: {integrity!r}")
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    return len(additions), len(additions) - orphan_count, orphan_count


def verify_enriched_database(
    rows: list[tuple[int, int | None, str, str, str]],
    base_rows: list[tuple[int, int | None, str, str, str]],
    archive: zipfile.ZipFile,
) -> tuple[int, int, int]:
    members = object_html_infos(archive)
    if len(members) != EXPECTED_ARCHIVE_PAGE_COUNT:
        raise ValueError(f"Unexpected archive HTML page count: {len(members)}")
    expected, orphan_count = expected_added_rows(base_rows, archive, members)
    if len(expected) != EXPECTED_ADDED_PAGE_COUNT or orphan_count != EXPECTED_ORPHAN_PAGE_COUNT:
        raise ValueError("The source archive did not produce the pinned import counts.")
    if rows[BASELINE_ROW_COUNT:] != expected:
        raise ValueError("The database is neither the pinned baseline nor the complete deterministic import.")
    validate_hierarchy(rows)
    return len(expected), len(expected) - orphan_count, orphan_count


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hbk", required=True, type=Path, help="Path to the pinned shcntx_ru.hbk source archive")
    parser.add_argument(
        "--db", type=Path,
        default=Path(__file__).resolve().parents[1] / "resources" / "help" / "shcntx_help.db",
        help="SQLite database to enrich (default: resources/help/shcntx_help.db)",
    )
    args = parser.parse_args()
    started = time.perf_counter()
    if not args.db.is_file():
        raise ValueError(f"SQLite database does not exist: {args.db}")

    db_hash = sha256_file(args.db)
    stream, archive = open_pinned_hbk(args.hbk)
    try:
        with sqlite3.connect(args.db) as connection:
            connection.execute("PRAGMA foreign_keys = ON")
            rows = read_nodes(connection)
            base_rows = validate_base_rows(rows)
            if db_hash == BASELINE_DB_SHA256:
                if len(rows) != BASELINE_ROW_COUNT:
                    raise ValueError("The pinned baseline file does not contain exactly 2673 rows.")
                added, linked, orphans = append_articles(connection, base_rows, archive)
                result = "Imported"
            else:
                if len(rows) <= BASELINE_ROW_COUNT:
                    raise ValueError("The database file hash is not the pinned baseline hash.")
                added, linked, orphans = verify_enriched_database(rows, base_rows, archive)
                connection.execute("BEGIN IMMEDIATE")
                try:
                    created_article_markdown = ensure_article_markdown_table(
                        connection, rows, archive, object_html_infos(archive),
                    )
                    integrity = connection.execute("PRAGMA integrity_check").fetchone()
                    if not integrity or integrity[0] != "ok":
                        raise ValueError(f"SQLite integrity check failed: {integrity!r}")
                    connection.commit()
                except Exception:
                    connection.rollback()
                    raise
                result = "Updated enriched database with linked article content" if created_article_markdown else "Already enriched"
            final_rows = read_nodes(connection)
            if len(final_rows) != BASELINE_ROW_COUNT + EXPECTED_ADDED_PAGE_COUNT:
                raise ValueError(f"Unexpected final row count: {len(final_rows)}")
            final_hash = sha256_file(args.db)
    finally:
        archive.close()
        stream.close()

    elapsed = time.perf_counter() - started
    db_size = args.db.stat().st_size
    print(
        f"{result}: {added:,} pages ({linked:,} linked, {orphans:,} root orphans); "
        f"{len(final_rows):,} rows, {db_size:,} bytes, SHA-256 {final_hash}; {elapsed:.2f}s"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, sqlite3.Error, ValueError, zipfile.BadZipFile) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
