from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence

import requests
from dotenv import dotenv_values


PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = PROJECT_ROOT / ".env"
ETSY_API_BASE = "https://openapi.etsy.com/v3/application"
REQUEST_TIMEOUT = 30


def read_env_lines() -> List[str]:
    """Reads the local .env file so updates can preserve unrelated keys."""
    if not ENV_PATH.exists():
        raise FileNotFoundError(f".env not found at {ENV_PATH}")
    return ENV_PATH.read_text(encoding="utf-8").splitlines()


def read_env_values() -> Dict[str, str]:
    """Returns parsed .env values as plain strings for the current run."""
    parsed = dotenv_values(ENV_PATH)
    return {key: value for key, value in parsed.items() if value is not None}


def write_env_values(updates: Dict[str, str]) -> None:
    """Writes one or more key/value updates back to .env without dropping other configuration."""
    lines = read_env_lines()
    for key, value in updates.items():
        replacement = f"{key}={value}"
        updated = False
        next_lines: List[str] = []
        for line in lines:
            if line.startswith(f"{key}="):
                next_lines.append(replacement)
                updated = True
            else:
                next_lines.append(line)
        if not updated:
            next_lines.append(replacement)
        lines = next_lines

    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def require_env_value(env: Dict[str, str], key: str) -> str:
    """Fails fast when a required Etsy credential or config value is missing."""
    value = (env.get(key) or "").strip()
    if not value:
        raise RuntimeError(f"{key} is required in .env before running this helper.")
    return value


def build_headers(env: Dict[str, str]) -> Dict[str, str]:
    """Builds the Etsy auth headers required on every Open API request in this helper."""
    api_key = require_env_value(env, "ETSY_API_KEY")
    api_secret = require_env_value(env, "ETSY_API_SECRET")
    access_token = require_env_value(env, "ETSY_ACCESS_TOKEN")
    return {
        "x-api-key": f"{api_key}:{api_secret}",
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
    }


def get_known_user_id(env: Dict[str, str]) -> str:
    """Returns the configured Etsy user_id or the known fallback captured from live validation."""
    return (env.get("ETSY_USER_ID") or "").strip() or "1244271281"


def get_known_shop_id(env: Dict[str, str]) -> str:
    """Returns the configured Etsy shop_id or the known fallback captured from live validation."""
    return (env.get("ETSY_SHOP_ID") or "").strip() or "66081950"


def get_json(path: str, headers: Dict[str, str]) -> Any:
    """Executes one Etsy GET request and returns parsed JSON with full error detail on failure."""
    response = requests.get(f"{ETSY_API_BASE}{path}", headers=headers, timeout=REQUEST_TIMEOUT)
    if not response.ok:
        raise RuntimeError(f"GET {path} failed: {response.status_code} {response.reason} - {response.text[:500]}")
    return response.json()


def prompt_yes_no(question: str, default: bool = True) -> bool:
    """Prompts for a yes/no decision while supporting a simple default answer."""
    suffix = "[Y/n]" if default else "[y/N]"
    while True:
        answer = input(f"{question} {suffix} ").strip().lower()
        if not answer:
            return default
        if answer in {"y", "yes"}:
            return True
        if answer in {"n", "no"}:
            return False
        print("Please answer y or n.")


def choose_one(items: Sequence[Dict[str, Any]], label: str, id_key: str, name_key: str) -> Dict[str, Any]:
    """Lets the operator select a single Etsy resource when the API returns multiple options."""
    rows = list(items)
    if not rows:
        raise RuntimeError(f"No {label} were returned.")

    if len(rows) == 1:
        selected = rows[0]
        print(f"Using {label[:-1]} {selected.get(name_key) or selected.get(id_key)} ({selected.get(id_key)})")
        return selected

    print("")
    print(f"Multiple {label} found:")
    for index, row in enumerate(rows, start=1):
        print(f"  {index}. {row.get(name_key) or row.get('title') or row.get(id_key)} [{row.get(id_key)}]")

    while True:
        selection = input(f"Select a {label[:-1]} number: ").strip()
        if selection.isdigit():
            numeric = int(selection)
            if 1 <= numeric <= len(rows):
                return rows[numeric - 1]
        print("Invalid selection. Try again.")


def flatten_taxonomy_nodes(nodes: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Flattens Etsy's nested seller-taxonomy tree so matching and selection stay straightforward."""
    flattened: List[Dict[str, Any]] = []
    for node in nodes:
        flattened.append(node)
        children = node.get("children") or []
        if isinstance(children, list):
            flattened.extend(flatten_taxonomy_nodes([child for child in children if isinstance(child, dict)]))
    return flattened


def score_taxonomy_node(node: Dict[str, Any]) -> int:
    """Ranks taxonomy nodes toward apparel-friendly defaults while still keeping broader options visible."""
    text = f"{node.get('name', '')} {node.get('long_name', '')}".lower()
    score = 0
    for keyword, weight in [
        ("t-shirt", 10),
        ("shirt", 9),
        ("clothing", 8),
        ("apparel", 8),
        ("top", 6),
        ("hoodie", 6),
        ("sweatshirt", 6),
        ("mug", 5),
        ("poster", 5),
        ("sticker", 5),
    ]:
        if keyword in text:
            score += weight
    return score


def choose_taxonomy(taxonomy_payload: Any) -> Dict[str, Any]:
    """Suggests the most relevant seller taxonomy nodes and lets the operator confirm the default choice."""
    nodes = taxonomy_payload.get("results") if isinstance(taxonomy_payload, dict) else taxonomy_payload
    if not isinstance(nodes, list):
        raise RuntimeError("Seller taxonomy response did not contain a results list.")

    flattened = flatten_taxonomy_nodes([node for node in nodes if isinstance(node, dict)])
    if not flattened:
        raise RuntimeError("Seller taxonomy response contained no selectable nodes.")

    ranked = sorted(flattened, key=score_taxonomy_node, reverse=True)
    suggested = [node for node in ranked if score_taxonomy_node(node) > 0][:5]
    if not suggested:
        suggested = ranked[:5]

    print("")
    print("Suggested taxonomy nodes:")
    for index, node in enumerate(suggested, start=1):
        name = node.get("name") or node.get("long_name") or "Unnamed"
        print(f"  {index}. {name} [{node.get('id')}]")

    if prompt_yes_no("Use one of these suggested taxonomy nodes?", default=True):
        while True:
            selection = input("Select a taxonomy number (1-5): ").strip()
            if selection.isdigit():
                numeric = int(selection)
                if 1 <= numeric <= len(suggested):
                    return suggested[numeric - 1]
            print("Invalid selection. Try again.")

    while True:
        search_term = input("Enter a taxonomy search term (for example: tshirt, mug, poster, sticker): ").strip().lower()
        matches = [
            node for node in flattened
            if search_term in str(node.get("name") or node.get("long_name") or "").lower()
        ][:10]
        if not matches:
            print("No taxonomy matches found. Try another term.")
            continue

        print("")
        print("Matching taxonomy nodes:")
        for index, node in enumerate(matches, start=1):
            name = node.get("name") or node.get("long_name") or "Unnamed"
            print(f"  {index}. {name} [{node.get('id')}]")

        selection = input("Select a taxonomy number: ").strip()
        if selection.isdigit():
            numeric = int(selection)
            if 1 <= numeric <= len(matches):
                return matches[numeric - 1]
        print("Invalid selection. Try again.")


def resolve_shop(env: Dict[str, str], headers: Dict[str, str]) -> Dict[str, Any]:
    """Uses configured Etsy IDs when present and otherwise falls back to the confirmed live account defaults."""
    configured_user_id = (env.get("ETSY_USER_ID") or "").strip()
    configured_shop_id = (env.get("ETSY_SHOP_ID") or "").strip()
    fallback_user_id = get_known_user_id(env)
    fallback_shop_id = get_known_shop_id(env)

    if configured_user_id and configured_shop_id:
        return {
            "shop_id": configured_shop_id,
            "shop_name": env.get("ETSY_SHOP_NAME") or "Configured Etsy Shop",
            "owner_user_id": configured_user_id,
        }

    user_id = configured_user_id or fallback_user_id
    shops_payload = get_json(f"/users/{user_id}/shops", headers)
    shops = shops_payload.get("results", []) if isinstance(shops_payload, dict) else []
    if not isinstance(shops, list):
        raise RuntimeError("The Etsy shops response did not contain a results list.")

    matching_shop = next(
        (
            shop for shop in shops
            if isinstance(shop, dict) and str(shop.get("shop_id") or "") == fallback_shop_id
        ),
        None,
    )
    if matching_shop is not None:
        return matching_shop

    shop_rows = [shop for shop in shops if isinstance(shop, dict)]
    if configured_shop_id:
        matching_configured_shop = next(
            (
                shop for shop in shop_rows
                if str(shop.get("shop_id") or "") == configured_shop_id
            ),
            None,
        )
        if matching_configured_shop is not None:
            return matching_configured_shop

    return choose_one(shop_rows, "shops", "shop_id", "shop_name")


def choose_shipping_profile(shop_id: str, headers: Dict[str, str]) -> Dict[str, Any]:
    """Selects the shipping profile required for physical listing creation."""
    shipping_payload = get_json(f"/shops/{shop_id}/shipping-profiles", headers)
    shipping_profiles = shipping_payload.get("results", []) if isinstance(shipping_payload, dict) else []
    if not isinstance(shipping_profiles, list) or len(shipping_profiles) == 0:
        raise RuntimeError(
            "No shipping profiles found. Create one in your Etsy Shop Manager first, then re-run this script."
        )

    profiles = [profile for profile in shipping_profiles if isinstance(profile, dict)]
    if len(profiles) == 1:
        selected = profiles[0]
        profile_name = selected.get("title") or selected.get("shipping_profile_id")
        if not prompt_yes_no(f"Use the only shipping profile returned ({profile_name})?", default=True):
            raise RuntimeError("Shipping profile selection aborted by user.")
        return selected

    return choose_one(profiles, "shipping profiles", "shipping_profile_id", "title")


def choose_readiness_state(shop_id: str, headers: Dict[str, str]) -> Dict[str, Any]:
    """Selects the processing profile Etsy currently documents as required for physical listings."""
    readiness_payload = get_json(f"/shops/{shop_id}/readiness-state-definitions", headers)
    readiness_states = readiness_payload.get("results", []) if isinstance(readiness_payload, dict) else []
    if not isinstance(readiness_states, list) or len(readiness_states) == 0:
        raise RuntimeError(
            "No processing profiles were found. Create one in Etsy Shop Manager or via the readiness-state API, then re-run this script."
        )

    print("")
    print("Etsy still documents readiness_state_id as required for physical listings, so this helper will capture it.")
    return choose_one(
        [state for state in readiness_states if isinstance(state, dict)],
        "processing profiles",
        "readiness_state_id",
        "display_name",
    )


def choose_shop_section(shop_id: str, headers: Dict[str, str]) -> str:
    """Lets the operator choose an optional default shop section or skip it cleanly."""
    sections_payload = get_json(f"/shops/{shop_id}/sections", headers)
    sections = sections_payload.get("results", []) if isinstance(sections_payload, dict) else []
    if not isinstance(sections, list) or len(sections) == 0:
        print("")
        print("No shop sections found. Skipping ETSY_DEFAULT_SHOP_SECTION_ID.")
        return ""

    section_rows = [section for section in sections if isinstance(section, dict)]
    print("")
    print("Optional default shop section:")
    for index, section in enumerate(section_rows, start=1):
        print(f"  {index}. {section.get('title') or section.get('shop_section_id')} [{section.get('shop_section_id')}]")
    print("  0. Skip")

    while True:
        selection = input("Select a default shop section number or 0 to skip: ").strip()
        if selection == "0":
            return ""
        if selection.isdigit():
            numeric = int(selection)
            if 1 <= numeric <= len(section_rows):
                return str(section_rows[numeric - 1].get("shop_section_id") or "")
        print("Invalid selection. Try again.")


def render_summary_table(rows: Sequence[Sequence[str]]) -> str:
    """Renders a compact plain-text table so written defaults are easy to review at the end."""
    widths = [max(len(row[index]) for row in rows) for index in range(len(rows[0]))]
    return "\n".join(
        " | ".join(cell.ljust(widths[index]) for index, cell in enumerate(row))
        for row in rows
    )


def main() -> int:
    """Fetches Etsy shop defaults interactively and writes the confirmed values back to .env."""
    env = read_env_values()
    os.environ["ETSY_USER_ID"] = get_known_user_id(env)
    os.environ["ETSY_SHOP_ID"] = get_known_shop_id(env)
    headers = build_headers(env)

    shop = resolve_shop(env, headers)
    shop_id = str(shop.get("shop_id") or "")
    if not shop_id:
        raise RuntimeError("Selected shop did not include a shop_id.")

    shipping_profile = choose_shipping_profile(shop_id, headers)
    shipping_profile_id = str(shipping_profile.get("shipping_profile_id") or "")
    if not shipping_profile_id:
        raise RuntimeError("Selected shipping profile did not include shipping_profile_id.")

    taxonomy_payload = get_json("/seller-taxonomy/nodes", headers)
    taxonomy_node = choose_taxonomy(taxonomy_payload)
    taxonomy_id = str(taxonomy_node.get("id") or "")
    if not taxonomy_id:
        raise RuntimeError("Selected taxonomy node did not include an id.")

    readiness_state = choose_readiness_state(shop_id, headers)
    readiness_state_id = str(readiness_state.get("readiness_state_id") or "")
    if not readiness_state_id:
        raise RuntimeError("Selected processing profile did not include readiness_state_id.")

    default_shop_section_id = choose_shop_section(shop_id, headers)

    updates = {
        "ETSY_USER_ID": get_known_user_id(env),
        "ETSY_SHOP_ID": shop_id,
        "ETSY_SHIPPING_PROFILE_ID": shipping_profile_id,
        "ETSY_DEFAULT_TAXONOMY_ID": taxonomy_id,
        "ETSY_READINESS_STATE_ID": readiness_state_id,
        "ETSY_DEFAULT_SHOP_SECTION_ID": default_shop_section_id,
    }
    write_env_values(updates)

    print("")
    print("Wrote Etsy defaults to .env:")
    rows = [
        ("Key", "Value"),
        ("ETSY_USER_ID", updates["ETSY_USER_ID"]),
        ("ETSY_SHOP_ID", shop_id),
        ("ETSY_SHIPPING_PROFILE_ID", shipping_profile_id),
        ("ETSY_DEFAULT_TAXONOMY_ID", taxonomy_id),
        ("ETSY_READINESS_STATE_ID", readiness_state_id),
        ("ETSY_DEFAULT_SHOP_SECTION_ID", default_shop_section_id or "(skipped)"),
    ]
    print(render_summary_table(rows))
    print("")
    print("Run npm run audit to confirm 100% readiness")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"fetch_etsy_defaults.py failed: {error}", file=sys.stderr)
        raise SystemExit(1)
