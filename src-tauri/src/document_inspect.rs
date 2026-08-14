//! Bounded inspection of office, PDF, and other non-plain-text files so the
//! agent can describe contents instead of treating ZIP/OLE binaries as empty
//! or as UTF-8 mojibake.

use anyhow::{Context, Result};
use serde_json::Value;
use std::io::{Cursor, Read, Write};
use std::path::Path;

const MAX_SHEETS: usize = 20;
const MAX_SHEET_ROWS: usize = 120;
const MAX_SHEET_COLS: usize = 40;
const MAX_XLSX_WRITE_ROWS: usize = 500;
const MAX_XLSX_WRITE_COLS: usize = 40;
const MAX_OOXML_FILES: usize = 80;
const MAX_OOXML_FILE_BYTES: usize = 1_500_000;
const MAX_PDF_READ_BYTES: usize = 4_000_000;

pub fn extension_lower(path: &Path) -> String {
    path.extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

pub fn is_spreadsheet_ext(ext: &str) -> bool {
    matches!(
        ext,
        "xlsx" | "xlsm" | "xls" | "xlsb" | "ods" | "csv" | "tsv"
    )
}

pub fn is_presentation_ext(ext: &str) -> bool {
    matches!(ext, "pptx" | "pptm" | "ppt")
}

pub fn is_word_ext(ext: &str) -> bool {
    matches!(ext, "docx" | "docm" | "doc")
}

pub fn is_pdf_ext(ext: &str) -> bool {
    ext == "pdf"
}

pub fn is_image_ext(ext: &str) -> bool {
    matches!(ext, "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp")
}

pub fn is_video_ext(ext: &str) -> bool {
    matches!(
        ext,
        "mp4" | "mov" | "m4v" | "webm" | "mkv" | "avi" | "wmv" | "flv" | "mpeg" | "mpg" | "3gp"
    )
}

pub fn is_audio_ext(ext: &str) -> bool {
    matches!(
        ext,
        "mp3" | "wav" | "flac" | "m4a" | "aac" | "ogg" | "wma" | "opus" | "aiff" | "aif"
    )
}

pub fn is_xlsx_write_ext(ext: &str) -> bool {
    matches!(ext, "xlsx" | "xlsm")
}

/// Read a file for the agent: extract office/PDF text, describe media, or
/// return capped UTF-8. Never dumps ZIP/OLE bytes as mojibake.
pub fn read_inspectable_file(path: &Path, max_bytes: usize) -> Result<String> {
    let ext = extension_lower(path);
    let size = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    let display = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());

    if matches!(ext.as_str(), "xlsx" | "xlsm" | "xls" | "xlsb" | "ods") {
        return extract_spreadsheet(path, &display, size, max_bytes);
    }
    if ext == "csv" || ext == "tsv" {
        return read_text_file(path, max_bytes);
    }
    if matches!(ext.as_str(), "pptx" | "pptm") {
        return extract_ooxml_text(
            path,
            &display,
            size,
            "PowerPoint",
            "ppt/slides/slide",
            "a:t",
            max_bytes,
        );
    }
    if ext == "ppt" {
        return Ok(ole_open_hint("PowerPoint", &display, size));
    }
    if matches!(ext.as_str(), "docx" | "docm") {
        return extract_docx(path, &display, size, max_bytes);
    }
    if ext == "doc" {
        return Ok(ole_open_hint("Word", &display, size));
    }
    if ext == "pdf" {
        return extract_pdf(path, &display, size, max_bytes);
    }
    if is_image_ext(&ext) {
        return Ok(format!(
            "Image file: {display} ({size} bytes, .{ext}). Use view_image to see it, or open_path to open it in the default app."
        ));
    }
    if is_video_ext(&ext) {
        return Ok(format!(
            "Video file: {display} ({size} bytes, .{ext}). Use view_video for a visual summary (no audio transcript), or open_path to play it."
        ));
    }
    if is_audio_ext(&ext) {
        return Ok(describe_audio_placeholder(&display, size, &ext));
    }

    read_text_or_binary_hint(path, &display, size, &ext, max_bytes)
}

pub fn describe_audio_placeholder(display: &str, size: u64, ext: &str) -> String {
    format!(
        "Audio file: {display} ({size} bytes, .{ext}). This tool does not transcribe speech. Use open_path to play it in the default app."
    )
}

fn ole_open_hint(kind: &str, display: &str, size: u64) -> String {
    format!(
        "Legacy {kind} file: {display} ({size} bytes). Text extraction is not available for this older format. Use open_path to open it in the default Windows app."
    )
}

fn extract_spreadsheet(path: &Path, display: &str, size: u64, max_bytes: usize) -> Result<String> {
    let mut workbook = calamine::open_workbook_auto(path).with_context(|| {
        format!(
            "Could not open spreadsheet {display}. If it is encrypted or corrupt, use open_path to open it in Excel."
        )
    })?;
    let names: Vec<String> = calamine::Reader::sheet_names(&workbook).to_vec();
    if names.is_empty() {
        return Ok(format!(
            "Excel workbook: {display} ({size} bytes) has no sheets. Use open_path to open it in Excel."
        ));
    }
    let mut out = format!(
        "Excel workbook: {display} ({size} bytes)\nSheets: {}\n",
        names.join(", ")
    );
    for (index, name) in names.iter().take(MAX_SHEETS).enumerate() {
        if out.len() >= max_bytes {
            out.push_str("\n…truncated; open the file in Excel for the rest.\n");
            break;
        }
        match calamine::Reader::worksheet_range(&mut workbook, name) {
            Ok(range) => {
                let (height, width) = range.get_size();
                out.push_str(&format!(
                    "\n=== Sheet: {name} ({height} rows × {width} cols, showing up to {MAX_SHEET_ROWS} rows) ===\n"
                ));
                let mut rendered_rows = 0usize;
                for row in range.rows().take(MAX_SHEET_ROWS) {
                    let cells: Vec<String> =
                        row.iter().take(MAX_SHEET_COLS).map(cell_text).collect();
                    if cells.iter().all(|cell| cell.is_empty()) {
                        continue;
                    }
                    out.push_str(&cells.join("\t"));
                    out.push('\n');
                    rendered_rows += 1;
                    if out.len() >= max_bytes {
                        break;
                    }
                }
                if rendered_rows == 0 {
                    out.push_str("(no cell text in the sampled range)\n");
                }
                if height > MAX_SHEET_ROWS || width > MAX_SHEET_COLS {
                    out.push_str(
                        "(sheet truncated for size; use open_path for the full workbook)\n",
                    );
                }
            }
            Err(error) => {
                out.push_str(&format!(
                    "\n=== Sheet: {name} ===\nCould not read this sheet ({error}).\n"
                ));
            }
        }
        if index + 1 == MAX_SHEETS && names.len() > MAX_SHEETS {
            out.push_str(&format!(
                "\n…{} more sheet(s) not shown. Use open_path to open the workbook.\n",
                names.len() - MAX_SHEETS
            ));
        }
    }
    if out.len() > max_bytes {
        out.truncate(max_bytes);
        out.push_str("\n…truncated.\n");
    }
    Ok(out)
}

fn cell_text(cell: &calamine::Data) -> String {
    match cell {
        calamine::Data::Empty => String::new(),
        calamine::Data::Error(error) => format!("#{error}"),
        other => {
            let text = other.to_string();
            if text.len() > 500 {
                format!("{}…", &text[..500])
            } else {
                text
            }
        }
    }
}

fn extract_ooxml_text(
    path: &Path,
    display: &str,
    size: u64,
    kind: &str,
    prefix: &str,
    tag: &str,
    max_bytes: usize,
) -> Result<String> {
    let file = std::fs::File::open(path)
        .with_context(|| format!("Could not open {kind} file {display}"))?;
    let mut archive = zip::ZipArchive::new(file).with_context(|| {
        format!("{display} is not a readable {kind} file. Use open_path to open it.")
    })?;
    let mut parts: Vec<(String, String)> = Vec::new();
    let count = archive.len().min(MAX_OOXML_FILES);
    for index in 0..count {
        let mut entry = match archive.by_index(index) {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let name = entry.name().replace('\\', "/");
        if !name.starts_with(prefix) || !name.ends_with(".xml") {
            continue;
        }
        if entry.size() as usize > MAX_OOXML_FILE_BYTES {
            continue;
        }
        let mut xml = String::new();
        if entry.read_to_string(&mut xml).is_err() {
            continue;
        }
        let text = xml_tag_text(&xml, tag);
        if !text.is_empty() {
            parts.push((name, text));
        }
    }
    parts.sort_by(|a, b| a.0.cmp(&b.0));
    if parts.is_empty() {
        return Ok(format!(
            "{kind} file: {display} ({size} bytes). No extractable slide/document text. Use open_path to open it."
        ));
    }
    let mut out = format!("{kind} file: {display} ({size} bytes)\n");
    for (index, (name, text)) in parts.iter().enumerate() {
        let label = name.rsplit('/').next().unwrap_or(name);
        out.push_str(&format!("\n=== {label} ===\n{text}\n"));
        if out.len() >= max_bytes || index >= 40 {
            out.push_str("\n…truncated; use open_path for the full file.\n");
            break;
        }
    }
    if out.len() > max_bytes {
        out.truncate(max_bytes);
        out.push_str("\n…truncated.\n");
    }
    Ok(out)
}

fn extract_docx(path: &Path, display: &str, size: u64, max_bytes: usize) -> Result<String> {
    let file =
        std::fs::File::open(path).with_context(|| format!("Could not open Word file {display}"))?;
    let mut archive = zip::ZipArchive::new(file).with_context(|| {
        format!("{display} is not a readable Word file. Use open_path to open it.")
    })?;
    let mut xml = String::new();
    match archive.by_name("word/document.xml") {
        Ok(mut entry) => {
            if entry.size() as usize > MAX_OOXML_FILE_BYTES {
                return Ok(format!(
                    "Word file: {display} ({size} bytes) is too large to extract here. Use open_path to open it."
                ));
            }
            entry.read_to_string(&mut xml)?;
        }
        Err(_) => {
            return Ok(format!(
                "Word file: {display} ({size} bytes). Could not find document text. Use open_path to open it."
            ));
        }
    }
    let text = xml_tag_text(&xml, "w:t");
    if text.trim().is_empty() {
        return Ok(format!(
            "Word file: {display} ({size} bytes). No extractable paragraph text. Use open_path to open it."
        ));
    }
    let mut out = format!("Word file: {display} ({size} bytes)\n\n{text}");
    if out.len() > max_bytes {
        out.truncate(max_bytes);
        out.push_str("\n…truncated.\n");
    }
    Ok(out)
}

fn xml_tag_text(xml: &str, local_tag: &str) -> String {
    let open = format!("<{local_tag}");
    let close = format!("</{local_tag}>");
    let mut chunks = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        let Some(gt) = after.find('>') else {
            break;
        };
        if after[..gt].ends_with('/') {
            rest = &after[gt + 1..];
            continue;
        }
        let inner = &after[gt + 1..];
        let Some(end) = inner.find(&close) else {
            break;
        };
        let piece = decode_xml_text(&inner[..end]);
        if !piece.trim().is_empty() {
            chunks.push(piece);
        }
        rest = &inner[end + close.len()..];
        if chunks.len() > 4_000 {
            break;
        }
    }
    chunks.join(" ")
}

fn decode_xml_text(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn extract_pdf(path: &Path, display: &str, size: u64, max_bytes: usize) -> Result<String> {
    let file =
        std::fs::File::open(path).with_context(|| format!("Could not open PDF {display}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_PDF_READ_BYTES as u64)
        .read_to_end(&mut bytes)?;
    if !bytes.starts_with(b"%PDF") {
        return Ok(format!(
            "File {display} ({size} bytes) is not a readable PDF. Use open_path to open it."
        ));
    }
    let page_hint = byte_count(&bytes, b"/Type /Page")
        .saturating_add(byte_count(&bytes, b"/Type/Page"))
        .saturating_sub(byte_count(&bytes, b"/Type /Pages"))
        .saturating_sub(byte_count(&bytes, b"/Type/Pages"));
    let text = extract_pdf_literal_strings(&bytes, max_bytes.saturating_sub(200));
    let mut out = format!("PDF: {display} ({size} bytes)");
    if page_hint > 0 {
        out.push_str(&format!(" · about {page_hint} page object(s)"));
    }
    out.push('\n');
    if text.trim().is_empty() {
        out.push_str(
            "No uncompressed text could be extracted (the PDF may be scanned, encrypted, or compressed). Use open_path to open it in the default PDF app.",
        );
    } else {
        out.push_str("Extracted text (bounded):\n");
        out.push_str(&text);
        out.push_str("\nUse open_path to open the full PDF if this sample is incomplete.");
    }
    if out.len() > max_bytes {
        out.truncate(max_bytes);
        out.push_str("\n…truncated.\n");
    }
    Ok(out)
}

fn byte_count(haystack: &[u8], needle: &[u8]) -> usize {
    haystack
        .windows(needle.len())
        .filter(|window| *window == needle)
        .count()
}

fn extract_pdf_literal_strings(bytes: &[u8], max_chars: usize) -> String {
    let mut out = String::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'(' {
            let mut cur = index + 1;
            let mut piece = String::new();
            while cur < bytes.len() {
                match bytes[cur] {
                    b'\\' => {
                        if cur + 1 < bytes.len() {
                            piece.push(bytes[cur + 1] as char);
                            cur += 2;
                            continue;
                        }
                    }
                    b')' => break,
                    b if b.is_ascii_graphic() || b == b' ' || b == b'\n' || b == b'\t' => {
                        piece.push(b as char);
                    }
                    _ => {}
                }
                cur += 1;
            }
            if piece.trim().len() >= 3 {
                if !out.is_empty() && !out.ends_with(' ') && !out.ends_with('\n') {
                    out.push(' ');
                }
                out.push_str(piece.trim());
            }
            index = cur + 1;
            if out.len() >= max_chars {
                break;
            }
            continue;
        }
        index += 1;
    }
    out
}

fn read_text_file(path: &Path, max_bytes: usize) -> Result<String> {
    let total = std::fs::metadata(path)?.len();
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)?;
    let content = String::from_utf8_lossy(&bytes).into_owned();
    if total > max_bytes as u64 || content.len() > max_bytes {
        let mut prefix = content;
        if prefix.len() > max_bytes {
            prefix.truncate(max_bytes);
        }
        Ok(format!(
            "{prefix}...(truncated, {total} bytes total; narrow the read or use grep)"
        ))
    } else {
        Ok(content)
    }
}

fn read_text_or_binary_hint(
    path: &Path,
    display: &str,
    size: u64,
    ext: &str,
    max_bytes: usize,
) -> Result<String> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)?;
    if looks_like_binary(&bytes) {
        let kind = if ext.is_empty() {
            "binary file".into()
        } else {
            format!(".{ext} file")
        };
        return Ok(format!(
            "{display} is a {kind} ({size} bytes), not plain text. Use open_path to open it with the default Windows app, or view_image/view_video when it is media."
        ));
    }
    match String::from_utf8(bytes.clone()) {
        Ok(content) => {
            if size > max_bytes as u64 || content.len() > max_bytes {
                let mut prefix = content;
                if prefix.len() > max_bytes {
                    prefix.truncate(max_bytes);
                }
                Ok(format!(
                    "{prefix}...(truncated, {size} bytes total; narrow the read or use grep)"
                ))
            } else {
                Ok(content)
            }
        }
        Err(_) => Ok(format!(
            "{display} ({size} bytes) is not valid UTF-8 text. Use open_path to open it with the default app."
        )),
    }
}

fn looks_like_binary(bytes: &[u8]) -> bool {
    if bytes.starts_with(b"PK")
        || bytes.starts_with(b"%PDF")
        || bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0])
    {
        return true;
    }
    if bytes.contains(&0) {
        return true;
    }
    let sample = &bytes[..bytes.len().min(4096)];
    if sample.is_empty() {
        return false;
    }
    let weird = sample
        .iter()
        .filter(|byte| **byte < 0x09 || (**byte > 0x0d && **byte < 0x20))
        .count();
    weird * 8 > sample.len()
}

/// Build a minimal .xlsx workbook from CSV/TSV/JSON-table text.
pub fn xlsx_from_tabular_text(content: &str) -> Result<(Vec<u8>, String)> {
    let rows = parse_tabular_text(content);
    let row_count = rows.len();
    let col_count = rows.iter().map(|row| row.len()).max().unwrap_or(0);
    let sheet_xml = worksheet_xml(&rows);
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        write_zip_file(&mut zip, options, "[Content_Types].xml", CONTENT_TYPES_XML)?;
        write_zip_file(&mut zip, options, "_rels/.rels", RELS_XML)?;
        write_zip_file(&mut zip, options, "xl/workbook.xml", WORKBOOK_XML)?;
        write_zip_file(
            &mut zip,
            options,
            "xl/_rels/workbook.xml.rels",
            WORKBOOK_RELS_XML,
        )?;
        write_zip_file(&mut zip, options, "xl/worksheets/sheet1.xml", &sheet_xml)?;
        zip.finish()?;
    }
    let summary = format!("spreadsheet with {row_count} rows × {col_count} columns");
    Ok((cursor.into_inner(), summary))
}

fn write_zip_file<W: Write + std::io::Seek>(
    zip: &mut zip::ZipWriter<W>,
    options: zip::write::SimpleFileOptions,
    name: &str,
    body: &str,
) -> Result<()> {
    zip.start_file(name, options)?;
    zip.write_all(body.as_bytes())?;
    Ok(())
}

pub fn parse_tabular_text(content: &str) -> Vec<Vec<String>> {
    let trimmed = content.trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() {
        return vec![vec![String::new()]];
    }
    if let Ok(Value::Array(rows)) = serde_json::from_str::<Value>(trimmed) {
        if rows.iter().all(|row| row.is_array() || row.is_object()) {
            let parsed: Vec<Vec<String>> = rows
                .into_iter()
                .take(MAX_XLSX_WRITE_ROWS)
                .map(json_row)
                .collect();
            if !parsed.is_empty() {
                return parsed;
            }
        }
    }
    let comma = trimmed.matches(',').count();
    let tab = trimmed.matches('\t').count();
    let delim = if tab > comma { '\t' } else { ',' };
    trimmed
        .lines()
        .take(MAX_XLSX_WRITE_ROWS)
        .map(|line| split_delimited(line, delim))
        .collect()
}

fn json_row(value: Value) -> Vec<String> {
    match value {
        Value::Array(cells) => cells
            .into_iter()
            .take(MAX_XLSX_WRITE_COLS)
            .map(json_cell)
            .collect(),
        Value::Object(map) => map
            .into_iter()
            .take(MAX_XLSX_WRITE_COLS)
            .map(|(key, value)| format!("{key}: {}", json_cell(value)))
            .collect(),
        other => vec![json_cell(other)],
    }
}

fn json_cell(value: Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text,
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        other => other.to_string(),
    }
}

fn split_delimited(line: &str, delim: char) -> Vec<String> {
    if delim == '\t' {
        return line
            .split('\t')
            .take(MAX_XLSX_WRITE_COLS)
            .map(|cell| cell.to_string())
            .collect();
    }
    let mut cells = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' if in_quotes => {
                if chars.peek() == Some(&'"') {
                    current.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            }
            '"' => in_quotes = true,
            c if c == delim && !in_quotes => {
                cells.push(std::mem::take(&mut current));
                if cells.len() >= MAX_XLSX_WRITE_COLS {
                    break;
                }
            }
            c => current.push(c),
        }
    }
    cells.push(current);
    cells.truncate(MAX_XLSX_WRITE_COLS);
    cells
}

fn worksheet_xml(rows: &[Vec<String>]) -> String {
    let mut body = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>"#,
    );
    for (row_index, row) in rows.iter().enumerate() {
        let row_number = row_index + 1;
        body.push_str(&format!("<row r=\"{row_number}\">"));
        for (col_index, cell) in row.iter().enumerate() {
            let coord = format!("{}{row_number}", column_name(col_index));
            body.push_str(&format!(
                "<c r=\"{coord}\" t=\"inlineStr\"><is><t>{}</t></is></c>",
                xml_escape(cell)
            ));
        }
        body.push_str("</row>");
    }
    body.push_str("</sheetData></worksheet>");
    body
}

fn column_name(mut index: usize) -> String {
    let mut name = String::new();
    loop {
        name.insert(0, (b'A' + (index % 26) as u8) as char);
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    name
}

fn xml_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\u{09}' | '\u{0A}' | '\u{0D}' => out.push(ch),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

const CONTENT_TYPES_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#;

const RELS_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#;

const WORKBOOK_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#;

const WORKBOOK_RELS_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xlsx_roundtrip_returns_sheet_cell_text() {
        let (bytes, summary) =
            xlsx_from_tabular_text("Name,Amount\nPayroll,42\nManpower,7").unwrap();
        assert!(summary.contains("2 rows") || summary.contains("3 rows"));
        let dir = std::env::temp_dir().join(format!("horma-xlsx-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("payroll.xlsx");
        std::fs::write(&path, bytes).unwrap();
        let text = read_inspectable_file(&path, 20_000).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(text.contains("Payroll"), "{text}");
        assert!(text.contains("42"), "{text}");
        assert!(text.to_ascii_lowercase().contains("sheet"), "{text}");
    }

    #[test]
    fn binary_zip_is_not_returned_as_mojibake() {
        let dir = std::env::temp_dir().join(format!("horma-bin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("archive.bin");
        std::fs::write(&path, b"PK\x03\x04not-text").unwrap();
        let text = read_inspectable_file(&path, 2000).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(text.contains("open_path"), "{text}");
        assert!(!text.contains("PK"), "{text}");
    }
}
