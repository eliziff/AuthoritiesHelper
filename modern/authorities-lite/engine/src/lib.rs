// The same small ABI as Legal Pinpointer; all legal analysis stays in legal-structure.
use legal_structure::{citation_lookup_key, citation_occurrences_in_text,
    provider_citations_in_text, provider_text_document_structure, ProviderTextInput};
use serde_json::{json, Value};
use std::{cell::RefCell, slice};
thread_local! { static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) }; }
fn run(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > 24_000_000 { return Err("Document is too large for this browser operation".into()); }
    let input: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    match input["op"].as_str() {
        Some("citations") => {
            let text = input["text"].as_str().ok_or("Missing citation text")?;
            let matches: Vec<Value> = provider_citations_in_text(text).into_iter().map(|hit| {
                let key = citation_lookup_key(hit.text);
                let mut value = serde_json::to_value(hit).unwrap();
                value["key"] = json!(key); value
            }).collect();
            Ok(json!({"ok": true, "offset_unit":"utf16", "matches": matches,
                "occurrences": citation_occurrences_in_text(text)}))
        }
        Some("structure") => {
            let source: ProviderTextInput = serde_json::from_value(input["input"].clone()).map_err(|e| e.to_string())?;
            let doc = provider_text_document_structure(source).map_err(|e| e.to_string())?;
            Ok(json!({"ok":true,"offset_unit":doc.offset_unit,"text_sha256":doc.text_sha256,
                "engine_source_sha256":legal_structure::ENGINE_SOURCE_SHA256,"nodes":doc.nodes}))
        }
        _ => Err("Unknown structure operation".into()),
    }
}
#[no_mangle] pub extern "C" fn legal_structure_alloc(length: usize) -> *mut u8 {
    Box::into_raw(vec![0_u8; length].into_boxed_slice()) as *mut u8
}
#[no_mangle] pub unsafe extern "C" fn legal_structure_dealloc(pointer: *mut u8, length: usize) {
    if !pointer.is_null() { drop(Box::from_raw(slice::from_raw_parts_mut(pointer, length))); }
}
#[no_mangle] pub unsafe extern "C" fn legal_structure_analyze(pointer: *const u8, length: usize) {
    let bytes = if pointer.is_null() { &[] } else { slice::from_raw_parts(pointer, length) };
    let result = run(bytes).unwrap_or_else(|error| json!({"ok":false,"error":error}));
    OUTPUT.with(|output| *output.borrow_mut() = serde_json::to_vec(&result).unwrap());
}
#[no_mangle] pub extern "C" fn legal_structure_output_pointer() -> *const u8 { OUTPUT.with(|o| o.borrow().as_ptr()) }
#[no_mangle] pub extern "C" fn legal_structure_output_length() -> usize { OUTPUT.with(|o| o.borrow().len()) }
