#!/usr/bin/env python3
"""Fetch public Melon chart pages and convert them to JSON or CSV."""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from html import unescape
from pathlib import Path
from typing import Iterable
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen

BASE_URL = "https://www.melon.com"
DEFAULT_TIMEOUT = 20.0
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6",
    "Referer": "https://www.melon.com/",
}
CHART_PATHS = {
    "top100": "/chart/index.htm",
    "day": "/chart/day/index.htm",
    "week": "/chart/week/index.htm",
    "month": "/chart/month/index.htm",
    "rise": "/chart/rise/index.htm",
}
ROW_RE = re.compile(r'(<tr class="lst(?:50|100)"[^>]*>.*?</tr>)', re.S)
TAG_RE = re.compile(r"<[^>]+>")
ANCHOR_RE = re.compile(r'<a [^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.S)


@dataclass(frozen=True)
class ParsedAnchor:
    href: str
    text: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch a Melon chart page and emit structured data."
    )
    parser.add_argument(
        "--chart",
        choices=sorted(CHART_PATHS),
        help="Named Melon chart to fetch.",
    )
    parser.add_argument(
        "--url",
        help="Optional full Melon chart URL. Overrides --chart when provided.",
    )
    parser.add_argument(
        "--class-cd",
        help="Optional Melon class code such as GN0000 or GN0200.",
    )
    parser.add_argument(
        "--day-time",
        help="Optional Melon hourly snapshot key such as 2026030820.",
    )
    parser.add_argument(
        "--format",
        choices=("json", "csv"),
        default="json",
        help="Output format.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Optional file path. Defaults to stdout.",
    )
    parser.add_argument(
        "--save-html",
        type=Path,
        help="Optional file path to save the raw HTML response.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        help="Optional max number of rows to keep after parsing.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT,
        help=f"Request timeout in seconds. Default: {DEFAULT_TIMEOUT}",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON output.",
    )
    args = parser.parse_args()
    if not args.chart and not args.url:
        parser.error("provide either --chart or --url")
    if args.limit is not None and args.limit <= 0:
        parser.error("--limit must be positive")
    return args


def main() -> int:
    args = parse_args()
    request_url = build_request_url(args.chart, args.url, args.class_cd, args.day_time)
    html, resolved_url = fetch_html(request_url, timeout=args.timeout)
    if args.save_html:
        write_text(args.save_html, html)

    payload = parse_chart_page(
        html=html,
        requested_url=request_url,
        resolved_url=resolved_url,
        requested_chart=args.chart,
        limit=args.limit,
    )

    if args.format == "json":
        output_text = render_json(payload, pretty=args.pretty)
    else:
        output_text = render_csv(payload)

    if args.output:
        write_text(args.output, output_text)
    else:
        sys.stdout.write(output_text)
        if not output_text.endswith("\n"):
            sys.stdout.write("\n")
    return 0


def build_request_url(
    chart: str | None,
    explicit_url: str | None,
    class_cd: str | None,
    day_time: str | None,
) -> str:
    base = explicit_url or urljoin(BASE_URL, CHART_PATHS[chart or "top100"])
    parts = urlsplit(base)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    if class_cd:
        query["classCd"] = class_cd
    if day_time:
        query["dayTime"] = day_time
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def fetch_html(url: str, timeout: float) -> tuple[str, str]:
    request = Request(url, headers=DEFAULT_HEADERS)
    with urlopen(request, timeout=timeout) as response:
        body = response.read().decode("utf-8", "ignore")
        return body, response.geturl()


def parse_chart_page(
    *,
    html: str,
    requested_url: str,
    resolved_url: str,
    requested_chart: str | None,
    limit: int | None,
) -> dict[str, object]:
    title = normalize_text(extract_first(r"<title>(.*?)</title>", html))
    chart_date = normalize_chart_date(
        extract_first(r'<span class="year">([^<]+)</span>', html)
        or extract_first(r'<span class="yyyymmdd">\s*(.*?)\s*</span>', html)
    )
    chart_time_or_label = normalize_text(extract_first(r'<span class="hour">([^<]+)</span>', html))

    rows = [parse_row(row_html) for row_html in ROW_RE.findall(html)]
    if not rows:
        raise SystemExit("No chart rows found in response.")
    if limit is not None:
        rows = rows[:limit]

    inferred_chart = requested_chart or infer_chart_name_from_title(title)
    payload = {
        "chart": inferred_chart,
        "title": title,
        "requested_url": requested_url,
        "resolved_url": resolved_url,
        "fetched_at_utc": datetime.now(timezone.utc).isoformat(),
        "chart_date": chart_date,
        "chart_time_or_label": chart_time_or_label,
        "row_count": len(rows),
        "songs": rows,
    }
    return payload


def parse_row(row_html: str) -> dict[str, object]:
    song_id = extract_first(r'data-song-no="(\d+)"', row_html)
    rank = to_int(extract_first(r'<span class="rank\s*">(\d+)</span>', row_html))
    movement_text = normalize_text(
        extract_first(r'<span title="([^"]+)" class="rank_wrap">', row_html)
    )
    movement = parse_movement(movement_text)

    title_block = extract_block(row_html, "rank01")
    artist_block = extract_block(row_html, "rank02")
    album_block = extract_block(row_html, "rank03")
    artist_block = re.sub(
        r'<span class="checkEllipsis"[^>]*>.*?</span>',
        "",
        artist_block,
        flags=re.S,
    )

    song_detail_href = extract_first(
        r'/song/detail\.htm\?songId=\d+|javascript:melon\.link\.goSongDetail\(\'\d+\'\);',
        row_html,
    )
    album_href = extract_first(
        r'/album/detail\.htm\?albumId=\d+|javascript:melon\.link\.goAlbumDetail\(\'\d+\'\);',
        row_html,
    )
    cover_url = extract_first(r'<img [^>]*src="([^"]+)"', row_html)
    like_count = normalize_number(
        extract_first(
            r'<button[^>]*class="button_etc like"[^>]*>.*?<span class="cnt">\s*(?:<span[^>]*>.*?</span>\s*)?([0-9,]+)\s*</span>',
            row_html,
        )
    )
    if like_count == 0:
        like_count = None

    song_anchor = first_anchor(title_block)
    artist_anchors = unique_anchors(artist_block)
    album_anchor = first_anchor(album_block)

    artists = [anchor.text for anchor in artist_anchors]
    artist_ids = [extract_id_from_href(anchor.href, "artistId", "goArtistDetail") for anchor in artist_anchors]
    artist_ids = [artist_id for artist_id in artist_ids if artist_id]
    album_id = extract_id_from_href(album_href, "albumId", "goAlbumDetail")

    return {
        "rank": rank,
        "movement": movement,
        "song_id": song_id,
        "song_title": song_anchor.text if song_anchor else None,
        "song_detail_url": song_detail_url(song_detail_href),
        "artist_names": artists,
        "artist_ids": artist_ids,
        "artist_urls": [artist_url(anchor.href) for anchor in artist_anchors],
        "album_id": album_id,
        "album_title": album_anchor.text if album_anchor else None,
        "album_url": album_url(album_href),
        "cover_url": cover_url,
        "like_count": like_count,
    }


def extract_block(row_html: str, rank_class: str) -> str:
    pattern = rf'<div class="ellipsis {re.escape(rank_class)}">(.*?)</div>'
    match = re.search(pattern, row_html, re.S)
    return match.group(1) if match else ""


def first_anchor(fragment: str) -> ParsedAnchor | None:
    anchors = parse_anchors(fragment)
    return anchors[0] if anchors else None


def unique_anchors(fragment: str) -> list[ParsedAnchor]:
    seen: set[tuple[str, str]] = set()
    unique: list[ParsedAnchor] = []
    for anchor in parse_anchors(fragment):
        key = (anchor.href, anchor.text)
        if key not in seen:
            seen.add(key)
            unique.append(anchor)
    return unique


def parse_anchors(fragment: str) -> list[ParsedAnchor]:
    anchors: list[ParsedAnchor] = []
    for href, raw_text in ANCHOR_RE.findall(fragment):
        text = normalize_text(strip_tags(raw_text))
        if text:
            anchors.append(ParsedAnchor(href=href, text=text))
    return anchors


def parse_movement(movement_text: str | None) -> dict[str, object]:
    if not movement_text:
        return {"raw": None, "direction": "unknown", "value": None}
    value = to_int(extract_first(r"(\d+)", movement_text))
    if "상승" in movement_text:
        direction = "up"
    elif "하락" in movement_text:
        direction = "down"
    elif "동일" in movement_text:
        direction = "same"
        value = 0
    elif "재진입" in movement_text:
        direction = "reentry"
    elif "진입" in movement_text or "new" in movement_text.lower():
        direction = "new"
    else:
        direction = "unknown"
    return {"raw": movement_text, "direction": direction, "value": value}


def infer_chart_name_from_title(title: str | None) -> str | None:
    if not title:
        return None
    normalized = title.lower()
    if "top100" in normalized:
        return "top100"
    if "일간" in title:
        return "day"
    if "주간" in title:
        return "week"
    if "월간" in title:
        return "month"
    if "급상승" in title:
        return "rise"
    return None


def extract_first(pattern: str, text: str) -> str | None:
    if text is None:
        return None
    match = re.search(pattern, text, re.S)
    if not match:
        return None
    if match.lastindex:
        return match.group(1)
    return match.group(0)


def strip_tags(text: str | None) -> str:
    if not text:
        return ""
    text = text.replace("<br>", " ").replace("<br/>", " ").replace("<br />", " ")
    return unescape(TAG_RE.sub(" ", text))


def normalize_text(text: str | None) -> str | None:
    if text is None:
        return None
    collapsed = " ".join(strip_tags(text).replace("\xa0", " ").split())
    return collapsed or None


def normalize_chart_date(text: str | None) -> str | None:
    value = normalize_text(text)
    if not value:
        return None
    if re.fullmatch(r"\d{4}\.\d{2}\.\d{2}", value):
        return value.replace(".", "-")
    return value


def normalize_number(text: str | None) -> int | None:
    value = normalize_text(text)
    if not value:
        return None
    digits = value.replace(",", "")
    return int(digits) if digits.isdigit() else None


def to_int(text: str | None) -> int | None:
    if text is None:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def absolute_url(href: str | None) -> str | None:
    if not href:
        return None
    return urljoin(BASE_URL, href)


def extract_id_from_href(href: str | None, query_key: str, js_function: str) -> str | None:
    if not href:
        return None
    from_query = extract_first(rf"{re.escape(query_key)}=(\d+)", href)
    if from_query:
        return from_query
    return extract_first(rf"{re.escape(js_function)}\(\'(\d+)\'\)", href)


def song_detail_url(href: str | None) -> str | None:
    song_id = extract_id_from_href(href, "songId", "goSongDetail")
    if song_id:
        return absolute_url(f"/song/detail.htm?songId={song_id}")
    return absolute_url(href)


def album_url(href: str | None) -> str | None:
    album_id = extract_id_from_href(href, "albumId", "goAlbumDetail")
    if album_id:
        return absolute_url(f"/album/detail.htm?albumId={album_id}")
    return absolute_url(href)


def artist_url(href: str | None) -> str | None:
    artist_id = extract_id_from_href(href, "artistId", "goArtistDetail")
    if artist_id:
        return absolute_url(f"/artist/timeline.htm?artistId={artist_id}")
    return absolute_url(href)


def render_json(payload: dict[str, object], pretty: bool) -> str:
    indent = 2 if pretty else None
    separators = None if pretty else (",", ":")
    return json.dumps(payload, ensure_ascii=False, indent=indent, separators=separators)


def render_csv(payload: dict[str, object]) -> str:
    songs = payload["songs"]
    if not isinstance(songs, list):
        raise SystemExit("Payload has no song rows to render.")

    metadata = {
        "chart": payload.get("chart"),
        "chart_date": payload.get("chart_date"),
        "chart_time_or_label": payload.get("chart_time_or_label"),
        "requested_url": payload.get("requested_url"),
        "resolved_url": payload.get("resolved_url"),
        "fetched_at_utc": payload.get("fetched_at_utc"),
    }

    fieldnames = [
        "chart",
        "chart_date",
        "chart_time_or_label",
        "requested_url",
        "resolved_url",
        "fetched_at_utc",
        "rank",
        "movement_direction",
        "movement_value",
        "movement_raw",
        "song_id",
        "song_title",
        "song_detail_url",
        "artist_names",
        "artist_ids",
        "artist_urls",
        "album_id",
        "album_title",
        "album_url",
        "cover_url",
        "like_count",
    ]

    from io import StringIO

    buffer = StringIO()
    writer = csv.DictWriter(buffer, fieldnames=fieldnames)
    writer.writeheader()
    for song in songs:
        if not isinstance(song, dict):
            continue
        movement = song.get("movement") or {}
        writer.writerow(
            {
                **metadata,
                "rank": song.get("rank"),
                "movement_direction": movement.get("direction"),
                "movement_value": movement.get("value"),
                "movement_raw": movement.get("raw"),
                "song_id": song.get("song_id"),
                "song_title": song.get("song_title"),
                "song_detail_url": song.get("song_detail_url"),
                "artist_names": "; ".join(as_list(song.get("artist_names"))),
                "artist_ids": "; ".join(as_list(song.get("artist_ids"))),
                "artist_urls": "; ".join(as_list(song.get("artist_urls"))),
                "album_id": song.get("album_id"),
                "album_title": song.get("album_title"),
                "album_url": song.get("album_url"),
                "cover_url": song.get("cover_url"),
                "like_count": song.get("like_count"),
            }
        )
    return buffer.getvalue()


def as_list(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    return []


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
