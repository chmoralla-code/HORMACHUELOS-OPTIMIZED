//! One-shot helper: print provider keys from OS keyring as KEY=value lines.
//! Never commit output. Used only to seed Vercel env vars.
use keyring::Entry;

fn main() {
    for p in [
        "deepseek",
        "openrouter",
        "cursor",
        "openai",
        "anthropic",
        "gemini",
        "glm",
    ] {
        match Entry::new("hormachuelos-optimized", p).and_then(|e| e.get_password()) {
            Ok(k) if !k.trim().is_empty() => {
                let env_name = match p {
                    "deepseek" => "DEEPSEEK_API_KEY",
                    "openrouter" => "OPENROUTER_API_KEY",
                    "cursor" => "CURSOR_API_KEY",
                    "openai" => "OPENAI_API_KEY",
                    "anthropic" => "ANTHROPIC_API_KEY",
                    "gemini" => "GEMINI_API_KEY",
                    "glm" => "GLM_API_KEY",
                    _ => continue,
                };
                println!("{env_name}={k}");
            }
            _ => {}
        }
    }
}
