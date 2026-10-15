//! Dump the OpenAPI spec for the Ergatai API to stdout.
//!
//! Usage:
//!   cargo run -p ergatai-api --example dump_openapi > openapi.json

use utoipa::OpenApi;

fn main() {
    let spec = ergatai_api::api::openapi::ApiDoc::openapi();
    let json = spec.to_pretty_json().expect("serialize OpenAPI spec");
    println!("{json}");
}
