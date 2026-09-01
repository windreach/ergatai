use std::io::{self, Write};

/// Prompt the user for input with a default value
pub fn prompt_with_default(prompt: &str, default: &str) -> String {
    print!("{} [{}]: ", prompt, default);
    io::stdout().flush().unwrap();

    let mut input = String::new();
    io::stdin().read_line(&mut input).unwrap();
    let input = input.trim();

    if input.is_empty() {
        default.to_string()
    } else {
        input.to_string()
    }
}

/// Prompt the user for required input (no default)
pub fn prompt_required(prompt: &str) -> String {
    loop {
        print!("{}: ", prompt);
        io::stdout().flush().unwrap();

        let mut input = String::new();
        io::stdin().read_line(&mut input).unwrap();
        let input = input.trim();

        if !input.is_empty() {
            return input.to_string();
        }

        println!("  ⚠ This field is required");
    }
}
