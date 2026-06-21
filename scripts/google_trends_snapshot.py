import argparse
import json
import re
import sys


def normalize(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s-]", " ", value.lower())).strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keywords-json", required=True)
    parser.add_argument("--limit", type=int, default=15)
    args = parser.parse_args()

    try:
        from pytrends.request import TrendReq
    except Exception as error:
        print(f"pytrends is unavailable: {error}", file=sys.stderr)
        return 1

    try:
        seed_keywords = json.loads(args.keywords_json)
    except json.JSONDecodeError as error:
        print(f"Invalid keywords JSON: {error}", file=sys.stderr)
        return 1

    normalized_seeds = [normalize(keyword) for keyword in seed_keywords if normalize(keyword)]
    pytrends = TrendReq(hl="en-US", tz=360)

    try:
        frame = pytrends.trending_searches(pn="united_states")
    except Exception as error:
        print(f"pytrends request failed: {error}", file=sys.stderr)
        return 1

    candidates = [str(value).strip() for value in frame[0].dropna().tolist()]
    filtered = []
    for index, candidate in enumerate(candidates):
        normalized_candidate = normalize(candidate)
        if not normalized_candidate:
            continue

        if normalized_seeds and not any(
            seed in normalized_candidate or normalized_candidate in seed for seed in normalized_seeds
        ):
            continue

        filtered.append(
            {
                "label": " ".join(normalized_candidate.split(" ")[:5]),
                "sourceScore": round(max(1, 18 - index), 2),
                "metadata": {
                    "query": candidate,
                    "rank": index + 1,
                    "source": "pytrends.trending_searches",
                },
            }
        )

    if not filtered:
        filtered = [
            {
                "label": " ".join(normalize(candidate).split(" ")[:5]),
                "sourceScore": round(max(1, 18 - index), 2),
                "metadata": {
                    "query": candidate,
                    "rank": index + 1,
                    "source": "pytrends.trending_searches",
                },
            }
            for index, candidate in enumerate(candidates[: args.limit])
            if normalize(candidate)
        ]

    print(json.dumps(filtered[: args.limit]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
