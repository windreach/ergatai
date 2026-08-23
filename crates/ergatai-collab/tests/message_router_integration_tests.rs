//! Integration tests for message_router — @mention extraction edge cases.
//!
//! These tests focus on `extract_mentions` (pure function, no NATS needed)
//! to prevent regressions in mention detection logic.

use ergatai_collab::message_router::extract_mentions;

// ── Basic extraction ─────────────────────────────────────────────────

#[test]
fn single_mention_at_start() {
    assert_eq!(extract_mentions("@agent1 please help"), vec!["agent1"]);
}

#[test]
fn single_mention_in_middle() {
    assert_eq!(extract_mentions("hello @agent2 world"), vec!["agent2"]);
}

#[test]
fn single_mention_at_end() {
    assert_eq!(extract_mentions("please help @agent3"), vec!["agent3"]);
}

#[test]
fn multiple_mentions_in_order() {
    let text = "@alice and @bob please review";
    let mentions = extract_mentions(text);
    assert_eq!(mentions, vec!["alice", "bob"]);
}

// ── Deduplication ────────────────────────────────────────────────────

#[test]
fn duplicate_mentions_are_deduped() {
    let text = "@agent1 do this, then @agent1 do that";
    let mentions = extract_mentions(text);
    assert_eq!(mentions, vec!["agent1"]);
}

#[test]
fn three_duplicates_become_one() {
    let text = "@x @y @x @z @x";
    let mentions = extract_mentions(text);
    assert_eq!(mentions.len(), 3);
    assert_eq!(mentions[0], "x");
    assert!(mentions.contains(&"y".to_string()));
    assert!(mentions.contains(&"z".to_string()));
}

// ── Name formats ─────────────────────────────────────────────────────

#[test]
fn mention_with_dashes() {
    assert_eq!(extract_mentions("@my-agent"), vec!["my-agent"]);
}

#[test]
fn mention_with_underscores() {
    assert_eq!(extract_mentions("@my_agent"), vec!["my_agent"]);
}

#[test]
fn mention_with_digits() {
    assert_eq!(extract_mentions("@agent42"), vec!["agent42"]);
}

#[test]
fn mention_with_mixed_case() {
    assert_eq!(extract_mentions("@ClaudeCode"), vec!["ClaudeCode"]);
}

// ── Email / URL avoidance ────────────────────────────────────────────

#[test]
fn email_address_not_matched() {
    let mentions = extract_mentions("email user@example.com please");
    assert!(
        mentions.is_empty() || !mentions.contains(&"example.com".to_string()),
        "Email should not produce false positive, got: {mentions:?}"
    );
}

#[test]
fn multiple_emails_not_matched() {
    let text = "contact alice@corp.com and bob@dev.org";
    let mentions = extract_mentions(text);
    assert!(mentions.is_empty(), "got: {mentions:?}");
}

// ── Adjacent mentions ────────────────────────────────────────────────

#[test]
fn adjacent_mentions_only_first_matches() {
    let mentions = extract_mentions("@agent1@agent2");
    assert_eq!(mentions, vec!["agent1"]);
}

#[test]
fn space_separated_mentions_both_match() {
    let mentions = extract_mentions("@agent1 @agent2");
    assert_eq!(mentions, vec!["agent1", "agent2"]);
}

// ── Multi-line mentions ──────────────────────────────────────────────

#[test]
fn mention_at_start_of_new_line() {
    let text = "some text\n@agent1 please help";
    let mentions = extract_mentions(text);
    assert_eq!(mentions, vec!["agent1"]);
}

#[test]
fn mentions_on_multiple_lines() {
    let text = "@alice do this\n@bob do that\n@charlie review";
    let mentions = extract_mentions(text);
    assert_eq!(mentions.len(), 3);
    assert!(mentions.contains(&"alice".to_string()));
    assert!(mentions.contains(&"bob".to_string()));
    assert!(mentions.contains(&"charlie".to_string()));
}

// ── Edge cases ───────────────────────────────────────────────────────

#[test]
fn empty_text() {
    assert!(extract_mentions("").is_empty());
}

#[test]
fn no_mentions() {
    assert!(extract_mentions("just regular text").is_empty());
}

#[test]
fn lone_at_sign() {
    assert!(extract_mentions("@").is_empty());
}

#[test]
fn at_followed_by_special_chars() {
    assert!(extract_mentions("@!@#@$").is_empty());
}

#[test]
fn tab_before_mention() {
    let text = "\t@agent1 help";
    let mentions = extract_mentions(text);
    assert_eq!(mentions, vec!["agent1"]);
}

#[test]
fn mention_after_punctuation() {
    let text = "done.@agent1";
    let mentions = extract_mentions(text);
    assert!(mentions.is_empty(), "got: {mentions:?}");
}

#[test]
fn mention_after_newline_with_spaces() {
    let text = "first line\n   @agent1 help";
    let mentions = extract_mentions(text);
    assert_eq!(mentions, vec!["agent1"]);
}

// ── Many mentions ────────────────────────────────────────────────────

#[test]
fn many_mentions_in_long_text() {
    let mut text = String::new();
    for i in 0..20 {
        text.push_str(&format!("@agent{i} please do task {i}\n"));
    }
    let mentions = extract_mentions(&text);
    assert_eq!(mentions.len(), 20);
}

// ── Non-mention @ patterns ───────────────────────────────────────────

#[test]
fn tmux_pane_id_not_matched() {
    let text = "inject into %15 now";
    let mentions = extract_mentions(text);
    assert!(mentions.is_empty());
}
