//! A small, versioned C ABI. UTF-8 JSON crosses the boundary; Rust owns every
//! returned buffer. No allocator, Rust layout or parser state crosses the ABI.

use octri_parser::{Address, Limits, ParserError, Request, wire};
use serde::Deserialize;
use std::{panic::catch_unwind, ptr, slice, str};

const MAX_INPUT_BYTES: usize = 128 * 1024 * 1024;

/// Opaque allocation. Hosts must use the accessor and release functions.
#[derive(Debug)]
pub struct Buffer(Vec<u8>);

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
enum Call {
    Report {
        #[serde(rename = "abiVersion")]
        abi_version: u32,
        request: Request,
        /// Compact location transport is opt-in; ABI v1's default stays exact.
        #[serde(default)]
        compact: bool,
    },
    Document {
        #[serde(rename = "abiVersion")]
        abi_version: u32,
        request: Request,
    },
    Serialize {
        #[serde(rename = "abiVersion")]
        abi_version: u32,
        document: String,
        format: String,
        #[serde(default)]
        limits: Limits,
    },
}

fn error(code: &str, message: impl Into<String>) -> String {
    wire::encode::<()>(Err(ParserError::new(code, message, Address::default())))
}

/// Safe entry point used by Rust tests and the foreign-function shim.
pub fn dispatch(input: &[u8]) -> String {
    if input.len() > MAX_INPUT_BYTES {
        return error("LIMIT_REQUEST_BYTES", "Binding request exceeds 128 MiB");
    }
    let text = match str::from_utf8(input) {
        Ok(text) => text,
        Err(_) => return error("INVALID_ENCODING", "Binding request must be UTF-8"),
    };
    let envelope: Call = match serde_json::from_str(text) {
        Ok(envelope) => envelope,
        Err(failure) => return error("INVALID_REQUEST", failure.to_string()),
    };
    let version = match &envelope {
        Call::Report { abi_version, .. }
        | Call::Document { abi_version, .. }
        | Call::Serialize { abi_version, .. } => *abi_version,
    };
    if version != 1 {
        return error("ABI_VERSION", "Expected native ABI version 1");
    }
    match envelope {
        Call::Report {
            request, compact, ..
        } => {
            let result = octri_parser_native::execute(request);
            if compact {
                wire::encode_report_ascii(result)
            } else {
                wire::encode(result)
            }
        }
        Call::Document { request, .. } => {
            wire::encode(octri_parser_native::execute_document(request))
        }
        Call::Serialize {
            document,
            format,
            limits,
            ..
        } => match serde_json::to_string(&limits) {
            Ok(limits) => wire::serialize_document(&document, &format, &limits),
            Err(failure) => error("INVALID_OPTIONS", failure.to_string()),
        },
    }
}

fn owned(bytes: Vec<u8>) -> *mut Buffer {
    Box::into_raw(Box::new(Buffer(bytes)))
}

#[unsafe(no_mangle)]
pub extern "C" fn octri_parser_abi_version() -> u32 {
    1
}

/// Allocate an input buffer. Zero and oversized allocations return null.
#[unsafe(no_mangle)]
pub extern "C" fn octri_parser_buffer_new(length: usize) -> *mut Buffer {
    if length == 0 || length > MAX_INPUT_BYTES {
        return ptr::null_mut();
    }
    owned(vec![0; length])
}

/// Execute one isolated call. Null plus zero is accepted as an empty request.
/// Panics become an error envelope; allocation failure remains process-fatal.
///
/// # Safety
/// Non-null `data` must reference `length` readable bytes for this call. Hosts
/// must not modify those bytes concurrently. Returned buffer must be freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn octri_parser_call(data: *const u8, length: usize) -> *mut Buffer {
    let result = if length > MAX_INPUT_BYTES {
        error("LIMIT_REQUEST_BYTES", "Binding request exceeds 128 MiB")
    } else if data.is_null() && length != 0 {
        error(
            "INVALID_REQUEST",
            "Nonempty request has a null data pointer",
        )
    } else {
        // SAFETY: The caller guarantees validity for nonempty input. A null
        // pointer is never passed to from_raw_parts, even for an empty slice.
        let input = if length == 0 {
            &[]
        } else {
            // SAFETY: Nonempty input is readable for length bytes by contract.
            unsafe { slice::from_raw_parts(data, length) }
        };
        catch_unwind(|| dispatch(input))
            .unwrap_or_else(|_| error("INTERNAL_ERROR", "Native parser panicked"))
    };
    owned(result.into_bytes())
}

/// # Safety
/// `buffer` is null or a live allocation returned by this library. Only freshly
/// allocated input buffers may be written; response bytes are read-only by contract.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn octri_parser_buffer_data(buffer: *mut Buffer) -> *mut u8 {
    if buffer.is_null() {
        return ptr::null_mut();
    }
    // SAFETY: A live allocation is required by the function contract.
    unsafe { (*buffer).0.as_ptr().cast_mut() }
}

/// # Safety
/// `buffer` is null or a live allocation returned by this library.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn octri_parser_buffer_len(buffer: *const Buffer) -> usize {
    if buffer.is_null() {
        return 0;
    }
    // SAFETY: A live allocation is required by the function contract.
    unsafe { (*buffer).0.len() }
}

/// Release through the same loaded library that allocated the buffer. Null is safe.
///
/// # Safety
/// A non-null buffer must be a live allocation from this library, freed exactly
/// once. No accessors, reads or writes may overlap its release.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn octri_parser_buffer_free(buffer: *mut Buffer) {
    if !buffer.is_null() {
        // SAFETY: The caller transfers its unique allocation back exactly once.
        drop(unsafe { Box::from_raw(buffer) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn versioned_envelopes_reject_invalid_transport() {
        for (input, code) in [
            (vec![255], "INVALID_ENCODING"),
            (b"{}".to_vec(), "INVALID_REQUEST"),
            (br#"{"abiVersion":2,"action":"report","request":{"operation":"parse","input":{"uri":"memory://test/api.yaml","content":"{}"}}}"#.to_vec(), "ABI_VERSION"),
        ] {
            assert!(dispatch(&input).contains(code), "{}", dispatch(&input));
        }
    }

    #[test]
    fn full_report_matches_native_without_compact_wire_changes()
    -> Result<(), Box<dyn std::error::Error>> {
        let request = json!({"operation":"analyze","input":{"uri":"memory://test/api.json","content":r#"{"openapi":"3.1.2","info":{"title":"雪","version":"1"},"paths":{}}"#}});
        let expected = serde_json::to_value(octri_parser_native::execute(serde_json::from_value(
            request.clone(),
        )?))?;
        let actual: Value = serde_json::from_str(&dispatch(
            json!({"abiVersion":1,"action":"report","request":request})
                .to_string()
                .as_bytes(),
        ))?;
        assert_eq!(actual, expected);
        Ok(())
    }

    #[test]
    fn buffer_lifetime_null_and_size_contract() {
        // SAFETY: Only library-owned live buffers or explicitly supported null
        // inputs are used, with exactly one free for each allocation.
        unsafe {
            assert_eq!(octri_parser_abi_version(), 1);
            assert!(octri_parser_buffer_new(MAX_INPUT_BYTES + 1).is_null());
            assert!(octri_parser_buffer_data(ptr::null_mut()).is_null());
            assert_eq!(octri_parser_buffer_len(ptr::null()), 0);
            octri_parser_buffer_free(ptr::null_mut());
            for (data, length, code) in [
                (ptr::null(), 0, "INVALID_REQUEST"),
                (ptr::null(), 1, "INVALID_REQUEST"),
                (ptr::null(), MAX_INPUT_BYTES + 1, "LIMIT_REQUEST_BYTES"),
            ] {
                let result = octri_parser_call(data, length);
                let bytes = slice::from_raw_parts(
                    octri_parser_buffer_data(result),
                    octri_parser_buffer_len(result),
                );
                assert!(str::from_utf8(bytes).is_ok_and(|text| text.contains(code)));
                octri_parser_buffer_free(result);
            }
            let input = octri_parser_buffer_new(2);
            ptr::copy_nonoverlapping(b"{}".as_ptr(), octri_parser_buffer_data(input), 2);
            let output = octri_parser_call(octri_parser_buffer_data(input), 2);
            octri_parser_buffer_free(input);
            assert!(octri_parser_buffer_len(output) > 0);
            octri_parser_buffer_free(output);
        }
    }

    #[test]
    fn compact_report_is_opt_in_and_preserves_expanded_locations()
    -> Result<(), Box<dyn std::error::Error>> {
        for generated in [false, true] {
            let request = json!({"operation":"analyze","input":{"uri":"memory://test/api.json","content":r#"{"openapi":"3.1.2","info":{"title":"雪","version":"1"},"paths":{},"x-data":{"a/b~c":18446744073709551615}}"#,"generated":generated}});
            let mut envelope = json!({"abiVersion":1,"action":"report","request":request});
            let full: Value = serde_json::from_str(&dispatch(envelope.to_string().as_bytes()))?;
            envelope["compact"] = json!(true);
            let mut compact: Value =
                serde_json::from_str(&dispatch(envelope.to_string().as_bytes()))?;
            assert_eq!(compact["Ok"]["wireVersion"], 1);
            let report = compact["Ok"].as_object_mut().ok_or("report object")?;
            report.remove("wireVersion");
            for source in report["sources"].as_array_mut().ok_or("sources array")? {
                let uri = source["uri"].clone();
                let locations = source["locations"].as_object_mut().ok_or("location map")?;
                for (pointer, position) in locations {
                    if position.is_object() {
                        continue;
                    }
                    let mut location = json!({"uri":uri,"pointer":pointer});
                    if let Some(coordinates) = position.as_array() {
                        for (name, value) in
                            ["line", "column", "offset"].into_iter().zip(coordinates)
                        {
                            if !value.is_null() {
                                location[name] = value.clone();
                            }
                        }
                    }
                    *position = location;
                }
            }
            assert_eq!(compact, full);
        }
        let invalid = json!({"abiVersion":1,"action":"report","compact":true,"request":{"operation":"validate","input":{"uri":"memory://test/api.json","content":"{}"}}});
        let error: Value = serde_json::from_str(&dispatch(invalid.to_string().as_bytes()))?;
        assert!(error.get("Err").is_some());
        assert!(error.get("wireVersion").is_none());
        Ok(())
    }
}
