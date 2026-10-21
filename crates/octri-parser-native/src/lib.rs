//! Native I/O policies. The parser core never imports this crate.

use octri_parser::{
    Address, ParserError, ReadContext, Report, Request, ResolveOptions, ResolvedSource, Resolver,
    Result,
};
use std::{
    fs,
    io::Read,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs},
    path::Path,
    time::Duration,
};
use url::Url;

#[derive(Debug, Default)]
pub struct NativeResolver;

/// Path inputs grant access to their containing directory. Content inputs grant
/// no file authority, even when their retrieval URI uses the file scheme.
pub fn execute(request: Request) -> Result<Report> {
    octri_parser::execute(prepare_request(request)?, &mut NativeResolver)
}

/// Document-only execution uses exactly the same native retrieval policy.
pub fn execute_document(request: Request) -> Result<octri_parser::DocumentOutput> {
    octri_parser::execute_document(prepare_request(request)?, &mut NativeResolver)
}

fn prepare_request(mut request: Request) -> Result<Request> {
    let uri = normalize_uri(&request.input.uri)?;
    if request.input.content.is_none()
        && uri.scheme() == "file"
        && request.options.resolve.file_root.is_none()
    {
        let file = uri
            .to_file_path()
            .map_err(|_| failure("INVALID_URI", "Invalid file URI", uri.as_str()))?;
        let root = file
            .parent()
            .ok_or_else(|| failure("INVALID_URI", "File path has no parent", uri.as_str()))?;
        request.options.resolve.file_root = Some(root.to_string_lossy().into_owned());
    }
    request.input.uri = uri.to_string();
    Ok(request)
}

pub fn normalize_uri(input: &str) -> Result<Url> {
    if let Ok(url) = Url::parse(input) {
        return Ok(url);
    }
    let path = Path::new(input);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| failure("FILE_READ", e.to_string(), input))?
            .join(path)
    };
    Url::from_file_path(path)
        .map_err(|_| failure("INVALID_URI", "Cannot convert path to file URI", input))
}

impl Resolver for NativeResolver {
    fn read(&mut self, uri: &str, context: ReadContext<'_>) -> Result<String> {
        self.read_with_identity(uri, context)
            .map(|source| source.content)
    }

    fn read_with_identity(
        &mut self,
        uri: &str,
        context: ReadContext<'_>,
    ) -> Result<ResolvedSource> {
        let url = Url::parse(uri).map_err(|e| failure("INVALID_URI", e.to_string(), uri))?;
        match url.scheme() {
            "file" => {
                read_file(&url, context.policy, context.max_bytes).map(|content| ResolvedSource {
                    content,
                    retrieval_uri: uri.into(),
                })
            }
            "http" | "https" => read_http(url, context.policy, context.max_bytes),
            _ => Err(failure(
                "RESOLVER_DENIED",
                "Unsupported retrieval scheme; supply a virtual file",
                uri,
            )),
        }
    }
}

fn read_file(url: &Url, policy: &ResolveOptions, max_bytes: usize) -> Result<String> {
    let uri = url.as_str();
    if !url.username().is_empty()
        || url.password().is_some()
        || url
            .host_str()
            .is_some_and(|host| host != "localhost" && !host.is_empty())
    {
        return Err(failure(
            "RESOLVER_DENIED",
            "Remote file authorities are not supported",
            uri,
        ));
    }
    let root = policy.file_root.as_ref().ok_or_else(|| {
        failure(
            "RESOLVER_DENIED",
            "Content inputs require an explicit fileRoot",
            uri,
        )
    })?;
    let root = fs::canonicalize(root).map_err(|e| failure("FILE_ROOT", e.to_string(), uri))?;
    if !root.is_dir() {
        return Err(failure("FILE_ROOT", "fileRoot must be a directory", uri));
    }
    let path = url
        .to_file_path()
        .map_err(|_| failure("INVALID_URI", "Invalid local file URI", uri))?;
    let path = fs::canonicalize(path).map_err(|e| failure("FILE_READ", e.to_string(), uri))?;
    if !path.starts_with(&root) {
        return Err(failure(
            "FILE_OUTSIDE_ROOT",
            "Reference escapes the allowed file root",
            uri,
        ));
    }
    let metadata = fs::metadata(&path).map_err(|e| failure("FILE_READ", e.to_string(), uri))?;
    if !metadata.is_file() {
        return Err(failure("FILE_READ", "Only regular files can be read", uri));
    }
    // cap-std resolves relative to an open directory capability. A symlink
    // swap between canonicalization and open cannot escape the root fence.
    let directory = cap_std::fs::Dir::open_ambient_dir(&root, cap_std::ambient_authority())
        .map_err(|e| failure("FILE_ROOT", e.to_string(), uri))?;
    let relative = path
        .strip_prefix(&root)
        .map_err(|_| failure("FILE_OUTSIDE_ROOT", "Reference escapes file root", uri))?;
    let file = directory
        .open(relative)
        .map_err(|e| failure("FILE_READ", e.to_string(), uri))?;
    if file
        .metadata()
        .map_err(|e| failure("FILE_READ", e.to_string(), uri))?
        .len()
        > max_bytes as u64
    {
        return Err(failure(
            "LIMIT_DOCUMENT_BYTES",
            "File exceeds document byte limit",
            uri,
        ));
    }
    bounded_read(file, max_bytes, uri)
}

fn read_http(mut url: Url, policy: &ResolveOptions, max_bytes: usize) -> Result<ResolvedSource> {
    if !policy.http {
        return Err(failure(
            "RESOLVER_DENIED",
            "HTTP resolution requires explicit opt-in",
            url.as_str(),
        ));
    }
    if policy.timeout_ms == 0 {
        return Err(failure(
            "INVALID_OPTIONS",
            "HTTP timeout must be positive",
            url.as_str(),
        ));
    }
    let timeout = Duration::from_millis(policy.timeout_ms);
    let started = std::time::Instant::now();
    for redirect in 0..=policy.max_redirects {
        let uri = url.as_str();
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(failure(
                "RESOLVER_DENIED",
                "HTTP references cannot contain credentials or change to another scheme",
                uri,
            ));
        }
        let host = url
            .host_str()
            .ok_or_else(|| failure("INVALID_URI", "HTTP URL has no hostname", uri))?
            .trim_start_matches('[')
            .trim_end_matches(']');
        if !policy.allow_hosts.is_empty()
            && !policy
                .allow_hosts
                .iter()
                .any(|allowed| host.eq_ignore_ascii_case(allowed))
        {
            return Err(failure(
                "HTTP_HOST_DENIED",
                "Hostname is not in allowHosts",
                uri,
            ));
        }
        let port = url
            .port_or_known_default()
            .ok_or_else(|| failure("INVALID_URI", "HTTP URL has no port", uri))?;
        let addresses: Vec<SocketAddr> = (host, port)
            .to_socket_addrs()
            .map_err(|e| failure("HTTP_DNS", e.to_string(), uri))?
            .collect();
        if addresses.is_empty()
            || (!policy.allow_private && addresses.iter().any(|a| !is_public_address(a.ip())))
        {
            return Err(failure(
                "HTTP_PRIVATE_ADDRESS",
                "HTTP target resolves to a non-public address",
                uri,
            ));
        }
        let remaining = timeout
            .checked_sub(started.elapsed())
            .ok_or_else(|| failure("HTTP_TIMEOUT", "HTTP retrieval deadline exceeded", uri))?;
        // Disable proxies and automatic redirects. Pin the checked DNS answers so
        // connect-time resolution cannot bypass the address policy.
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(remaining)
            .connect_timeout(remaining)
            .resolve_to_addrs(host, &addresses)
            .build()
            .map_err(|e| failure("HTTP_CLIENT", e.to_string(), uri))?;
        let response = client
            .get(url.clone())
            .header("Accept-Encoding", "identity")
            .send()
            .map_err(|e| {
                failure(
                    if e.is_timeout() {
                        "HTTP_TIMEOUT"
                    } else {
                        "HTTP_READ"
                    },
                    e.to_string(),
                    uri,
                )
            })?;
        if response.status().is_redirection() {
            if redirect == policy.max_redirects {
                return Err(failure("HTTP_REDIRECT_LIMIT", "Too many redirects", uri));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| {
                    failure(
                        "HTTP_REDIRECT",
                        "Redirect has no valid Location header",
                        uri,
                    )
                })?;
            url = url
                .join(location)
                .map_err(|e| failure("HTTP_REDIRECT", e.to_string(), uri))?;
            // Fragments select schema targets; they are not retrieval identity.
            url.set_fragment(None);
            continue;
        }
        if !response.status().is_success() {
            return Err(failure(
                "HTTP_STATUS",
                format!("HTTP retrieval returned {}", response.status()),
                uri,
            ));
        }
        if response
            .headers()
            .get(reqwest::header::CONTENT_ENCODING)
            .is_some_and(|v| v != "identity")
        {
            return Err(failure(
                "HTTP_ENCODING",
                "Compressed HTTP responses are not accepted",
                uri,
            ));
        }
        if response
            .content_length()
            .is_some_and(|size| size > max_bytes as u64)
        {
            return Err(failure(
                "LIMIT_DOCUMENT_BYTES",
                "HTTP response exceeds byte limit",
                uri,
            ));
        }
        return bounded_read(response, max_bytes, uri).map(|content| ResolvedSource {
            content,
            retrieval_uri: uri.into(),
        });
    }
    Err(failure(
        "HTTP_REDIRECT_LIMIT",
        "Too many redirects",
        url.as_str(),
    ))
}

fn bounded_read(reader: impl Read, max: usize, uri: &str) -> Result<String> {
    let mut bytes = Vec::new();
    reader
        .take(max.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| failure("READ_FAILED", e.to_string(), uri))?;
    if bytes.len() > max {
        return Err(failure(
            "LIMIT_DOCUMENT_BYTES",
            "Retrieved document exceeds byte limit",
            uri,
        ));
    }
    String::from_utf8(bytes)
        .map_err(|_| failure("INVALID_ENCODING", "Documents must be UTF-8", uri))
}

/// Conservative public-unicast allowlist, including recent IANA exclusions.
/// IPv4-mapped IPv6 addresses are classified by their embedded IPv4 address.
pub fn is_public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => public_v4(address),
        IpAddr::V6(address) => {
            if let Some(address) = address.to_ipv4_mapped() {
                return public_v4(address);
            }
            let value = u128::from(address);
            in_v6(value, Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0), 3)
                && !in_v6(value, Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 23)
                && !in_v6(value, Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0), 32)
                && !in_v6(value, Ipv6Addr::new(0x2002, 0, 0, 0, 0, 0, 0, 0), 16)
                && !in_v6(value, Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0), 20)
        }
    }
}
fn in_v6(value: u128, base: Ipv6Addr, bits: u32) -> bool {
    value >> (128 - bits) == u128::from(base) >> (128 - bits)
}
fn public_v4(address: Ipv4Addr) -> bool {
    let value = u32::from(address);
    let denied = [
        (0x00000000, 8),
        (0x0a000000, 8),
        (0x64400000, 10),
        (0x7f000000, 8),
        (0xa9fe0000, 16),
        (0xac100000, 12),
        (0xc0000000, 24),
        (0xc0000200, 24),
        (0xc0586300, 24),
        (0xc0a80000, 16),
        (0xc6120000, 15),
        (0xc6336400, 24),
        (0xcb007100, 24),
        (0xe0000000, 3),
    ];
    !denied
        .iter()
        .any(|(base, bits)| value >> (32 - bits) == base >> (32 - bits))
}
fn failure(code: &str, message: impl Into<String>, uri: &str) -> ParserError {
    ParserError::new(
        code,
        message,
        Address {
            uri: uri.into(),
            pointer: String::new(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_addresses_exclude_special_use_ranges() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "192.0.2.1",
            "224.0.0.1",
            "::1",
            "::ffff:192.168.0.1",
            "64:ff9b:1::c0a8:1",
            "100:0:0:1::1",
            "3fff::1",
            "5f00::1",
            "2001:db8::1",
            "fe80::1",
            "fc00::1",
        ] {
            assert!(
                !is_public_address(address.parse().unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED))),
                "{address}"
            );
        }
        for address in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(
                is_public_address(address.parse().unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED))),
                "{address}"
            );
        }
    }
}
