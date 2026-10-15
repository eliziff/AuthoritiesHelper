// Native window only. Application operations run in the parent over private
// process pipes; no socket, local web server or host-object access is exposed.
#![windows_subsystem = "windows"]

use std::cell::{Cell, OnceCell, RefCell};
use std::collections::HashMap;
use std::io::{self, BufWriter, Read, Write};
use std::result::Result;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, write::EncoderWriter};
use serde_json::{json, Value};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::*;
use windows::core::{Interface, BOOL, HRESULT, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
use windows::Win32::System::Com::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::*;
use windows::Win32::UI::Input::KeyboardAndMouse::GetFocus;
use windows::Win32::UI::Shell::*;
use windows::Win32::UI::WindowsAndMessaging::*;

const REQUEST_LIMIT: usize = 132_000;
// The page's native runtime posts whole documents under /runtime/.
const RUNTIME_REQUEST_LIMIT: usize = 128 * 1024 * 1024;
const RESPONSE_LIMIT: usize = 128 * 1024 * 1024;
const RESPONSE_WAIT: Duration = Duration::from_secs(120);
const WM_INCOMING: u32 = WM_APP + 1;
const EXPIRY_TIMER: usize = 1;

/// A parent frame: its JSON header and its raw body in a movable global block,
/// which becomes the response stream without another copy.
struct Frame(Value, Body);

struct Body(usize, usize);

impl Body {
    fn read(input: &mut impl Read, length: usize) -> io::Result<Body> {
        if length == 0 { return Ok(Body(0, 0)); }
        unsafe {
            let block = GlobalAlloc(GMEM_MOVEABLE, length).map_err(io::Error::other)?;
            let body = Body(block.0 as usize, length);
            let bytes = std::slice::from_raw_parts_mut(GlobalLock(block) as *mut u8, length);
            let read = input.read_exact(bytes);
            let _ = GlobalUnlock(block);
            read.map(|_| body)
        }
    }

    fn into_stream(self) -> windows::core::Result<IStream> {
        let (block, length) = (HGLOBAL(self.0 as _), self.1 as u64);
        std::mem::forget(self);
        unsafe {
            let stream = CreateStreamOnHGlobal(block, true)?;
            // A global block may be larger than requested; the stream ends at the body.
            stream.SetSize(length)?;
            Ok(stream)
        }
    }
}

impl Drop for Body {
    fn drop(&mut self) {
        if self.0 != 0 { unsafe { let _ = GlobalFree(Some(HGLOBAL(self.0 as _))); } }
    }
}

enum Incoming { Frame(Frame), Stopped }

#[derive(Clone)]
struct View {
    environment: ICoreWebView2Environment,
    controller: ICoreWebView2Controller,
    webview: ICoreWebView2,
}

struct Waiting {
    args: ICoreWebView2WebResourceRequestedEventArgs,
    deferral: ICoreWebView2Deferral,
    deadline: Instant,
}

struct Shell {
    window: Cell<HWND>,
    title: HSTRING,
    origin: String,
    profile: HSTRING,
    view: RefCell<Option<View>>,
    pending: RefCell<HashMap<u64, Waiting>>,
    sequence: Cell<u64>,
    signing_in: Cell<bool>,
    exit_code: Cell<i32>,
    incoming: Receiver<Incoming>,
    sender: RefCell<Option<Sender<Incoming>>>,
}

thread_local! {
    // Every WebView2 object lives on the UI thread; so does this state.
    static SHELL: OnceCell<&'static Shell> = const { OnceCell::new() };
}

fn shell() -> Option<&'static Shell> {
    SHELL.with(|cell| cell.get().copied())
}

fn view() -> Option<View> {
    shell().and_then(|shell| shell.view.borrow().clone())
}

fn send(message: &Value) {
    let mut line = serde_json::to_vec(message).unwrap();
    line.push(b'\n');
    let mut output = io::stdout().lock();
    let _ = output.write_all(&line).and_then(|_| output.flush());
}

/// Writes the request line, base64-encoding the body straight into the pipe.
fn send_request(id: u64, url: &str, method: &str, headers: serde_json::Map<String, Value>, body: &[u8]) -> io::Result<()> {
    let mut head = serde_json::to_vec(&json!({ "type": "request", "id": id, "url": url, "method": method, "headers": headers })).unwrap();
    head.pop();
    let mut output = BufWriter::with_capacity(1 << 16, io::stdout().lock());
    output.write_all(&head)?;
    output.write_all(b",\"body\":\"")?;
    let mut encoder = EncoderWriter::new(output, &STANDARD);
    encoder.write_all(body)?;
    let mut output = encoder.finish()?;
    output.write_all(b"\"}\n")?;
    output.flush()
}

/// Scheme, authority (with any user information and port) and path of an absolute URL.
fn parts(url: &str) -> Option<(&str, &str, &str)> {
    let (scheme, rest) = url.split_once("://")?;
    let (authority, tail) = rest.split_at(rest.find(['/', '?', '#']).unwrap_or(rest.len()));
    Some((scheme, authority, &tail[..tail.find(['?', '#']).unwrap_or(tail.len())]))
}

fn origin_of(url: &str) -> Option<String> {
    let (scheme, authority, _) = parts(url)?;
    let (scheme, authority) = (scheme.to_ascii_lowercase(), authority.to_ascii_lowercase());
    let default = if scheme == "https" { ":443" } else if scheme == "http" { ":80" } else { "" };
    let authority = if !default.is_empty() && authority.ends_with(default) { &authority[..authority.len() - default.len()] } else { &authority };
    Some(format!("{scheme}://{authority}"))
}

fn host(authority: &str) -> &str {
    let authority = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    authority.split(':').next().unwrap_or(authority)
}

fn open_external(url: &str) {
    if matches!(parts(url), Some((scheme, _, _)) if scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("http")) {
        unsafe { ShellExecuteW(None, None, &HSTRING::from(url), None, None, SW_SHOWNORMAL); }
    }
}

fn take(get: impl FnOnce(*mut PWSTR) -> windows::core::Result<()>) -> windows::core::Result<String> {
    let mut value = PWSTR::null();
    get(&mut value)?;
    Ok(take_pwstr(value))
}

fn user_initiated(get: impl FnOnce(*mut BOOL) -> windows::core::Result<()>) -> bool {
    let mut value = BOOL(0);
    get(&mut value).is_ok() && value.as_bool()
}

fn fail(message: &str) {
    eprintln!("{message}");
    let Some(shell) = shell() else { std::process::exit(1) };
    unsafe {
        MessageBoxW(Some(shell.window.get()), &HSTRING::from(message), &shell.title, MB_OK | MB_ICONERROR);
        shell.exit_code.set(1);
        let _ = PostMessageW(Some(shell.window.get()), WM_CLOSE, WPARAM(0), LPARAM(0));
    }
}

fn fail_with(error: &windows::core::Error) {
    if error.code() == HRESULT::from_win32(ERROR_FILE_NOT_FOUND.0) {
        fail("Install Microsoft Edge WebView2 Runtime, then reopen this program.");
    } else {
        fail(&error.message());
    }
}

fn start(shell: &'static Shell) {
    let created = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(move |result, environment| {
        if let Err(error) = result.and_then(|_| environment.ok_or_else(|| E_POINTER.into()).and_then(|environment| {
            let parent = environment.clone();
            let handler = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(move |result, controller| {
                if let Err(error) = result.and_then(|_| controller.ok_or_else(|| E_POINTER.into()))
                    .and_then(|controller| unsafe { attach(shell, environment, controller) }) {
                    fail_with(&error);
                }
                Ok(())
            }));
            unsafe { parent.CreateCoreWebView2Controller(shell.window.get(), &handler) }
        })) {
            fail_with(&error);
        }
        Ok(())
    }));
    if let Err(error) = unsafe { CreateCoreWebView2EnvironmentWithOptions(PCWSTR::null(), &shell.profile, None, &created) } {
        fail_with(&error);
    }
}

unsafe fn attach(shell: &'static Shell, environment: ICoreWebView2Environment, controller: ICoreWebView2Controller) -> windows::core::Result<()> {
    let webview = controller.CoreWebView2()?;
    *shell.view.borrow_mut() = Some(View { environment, controller: controller.clone(), webview: webview.clone() });
    resize(shell.window.get());
    if GetFocus() == shell.window.get() {
        controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)?;
    }
    let settings = webview.Settings()?;
    settings.SetAreHostObjectsAllowed(false)?;
    settings.SetIsWebMessageEnabled(false)?;
    // Include worker requests: the document engine reads database ranges and
    // provider responses inside its Worker.
    webview.cast::<ICoreWebView2_22>()?.AddWebResourceRequestedFilterWithRequestSourceKinds(
        &HSTRING::from(format!("{}/*", shell.origin)), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
        COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL)?;
    let mut token = 0i64;
    webview.add_WebResourceRequested(&WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
        if let Some(args) = args { request(shell, args); }
        Ok(())
    })), &mut token)?;
    webview.add_NavigationStarting(&NavigationStartingEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        let uri = take(|value| unsafe { args.Uri(value) })?;
        if origin_of(&uri).as_deref() == Some(shell.origin.as_str()) { shell.signing_in.set(false); return Ok(()); }
        if let Some((scheme, authority, path)) = parts(&uri) {
            let https = scheme.eq_ignore_ascii_case("https");
            // OpenRouter's PKCE flow navigates away and returns to this profile
            // with a code. Keep its sessionStorage across that trip.
            if https && host(authority).eq_ignore_ascii_case("openrouter.ai") && path.starts_with("/auth") { shell.signing_in.set(true); }
            if shell.signing_in.get() && https { return Ok(()); }
        }
        args.SetCancel(true)?;
        if user_initiated(|value| args.IsUserInitiated(value)) { open_external(&uri); }
        Ok(())
    })), &mut token)?;
    webview.add_NewWindowRequested(&NewWindowRequestedEventHandler::create(Box::new(|_, args| {
        let Some(args) = args else { return Ok(()) };
        args.SetHandled(true)?;
        if user_initiated(|value| args.IsUserInitiated(value)) { open_external(&take(|value| args.Uri(value))?); }
        Ok(())
    })), &mut token)?;
    webview.add_ProcessFailed(&ProcessFailedEventHandler::create(Box::new(|_, _| {
        fail("The application window stopped. Close and reopen the program.");
        Ok(())
    })), &mut token)?;
    // Responses are read off the UI thread; WebView2 is touched only on it.
    let sender = shell.sender.borrow_mut().take().unwrap();
    let window = shell.window.get().0 as usize;
    std::thread::spawn(move || read_frames(sender, window));
    webview.Navigate(&HSTRING::from(format!("{}/", shell.origin)))?;
    send(&json!({ "type": "ready" }));
    Ok(())
}

fn read_content(request: &ICoreWebView2WebResourceRequest, limit: usize) -> Result<Vec<u8>, String> {
    let Ok(stream) = (unsafe { request.Content() }) else { return Ok(Vec::new()) };
    let mut body = Vec::new();
    let mut status = STATSTG::default();
    if unsafe { stream.Stat(&mut status, STATFLAG_NONAME) }.is_ok() {
        body.reserve(status.cbSize.min(limit as u64) as usize);
    }
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let mut count = 0u32;
        unsafe { stream.Read(buffer.as_mut_ptr() as _, buffer.len() as u32, Some(&mut count)) }.ok().map_err(|error| error.message())?;
        if count == 0 { return Ok(body); }
        if body.len() + count as usize > limit { return Err("The request is too large.".into()); }
        body.extend_from_slice(&buffer[..count as usize]);
    }
}

fn request(shell: &'static Shell, args: ICoreWebView2WebResourceRequestedEventArgs) {
    let Ok(deferral) = (unsafe { args.GetDeferral() }) else { return };
    let id = shell.sequence.get() + 1;
    shell.sequence.set(id);
    let sent = (|| -> Result<(), String> {
        let request = unsafe { args.Request() }.map_err(|error| error.message())?;
        let url = take(|value| unsafe { request.Uri(value) }).map_err(|error| error.message())?;
        let method = take(|value| unsafe { request.Method(value) }).map_err(|error| error.message())?;
        let mut headers = serde_json::Map::new();
        unsafe {
            let iterator = request.Headers().and_then(|headers| headers.GetIterator()).map_err(|error| error.message())?;
            let mut more = BOOL(0);
            while iterator.HasCurrentHeader(&mut more).is_ok() && more.as_bool() {
                let (mut name, mut value) = (PWSTR::null(), PWSTR::null());
                if iterator.GetCurrentHeader(&mut name, &mut value).is_ok() {
                    headers.insert(take_pwstr(name).to_ascii_lowercase(), Value::String(take_pwstr(value)));
                }
                if iterator.MoveNext(&mut more).is_err() { break; }
            }
        }
        let limit = if url.starts_with(&format!("{}/runtime/", shell.origin)) { RUNTIME_REQUEST_LIMIT } else { REQUEST_LIMIT };
        let body = read_content(&request, limit)?;
        let mut pending = shell.pending.borrow_mut();
        if pending.is_empty() {
            unsafe { SetTimer(Some(shell.window.get()), EXPIRY_TIMER, 1000, None); }
        }
        pending.insert(id, Waiting { args: args.clone(), deferral: deferral.clone(), deadline: Instant::now() + RESPONSE_WAIT });
        drop(pending);
        send_request(id, &url, &method, headers, &body).map_err(|error| error.to_string())
    })();
    if let Err(message) = sent {
        shell.pending.borrow_mut().remove(&id);
        respond_error(&args, &deferral, &message);
    }
}

fn respond(args: &ICoreWebView2WebResourceRequestedEventArgs, deferral: &ICoreWebView2Deferral,
    status: i32, reason: &str, headers: &str, body: Body) -> windows::core::Result<()> {
    let view = view().ok_or_else(|| windows::core::Error::from(E_UNEXPECTED))?;
    let stream = body.into_stream()?;
    unsafe {
        let response = view.environment.CreateWebResourceResponse(&stream, status, &HSTRING::from(reason), &HSTRING::from(headers))?;
        args.SetResponse(&response)?;
        deferral.Complete()
    }
}

fn respond_error(args: &ICoreWebView2WebResourceRequestedEventArgs, deferral: &ICoreWebView2Deferral, message: &str) {
    let body = unsafe { GlobalAlloc(GMEM_MOVEABLE, message.len().max(1)) }.map(|block| unsafe {
        std::ptr::copy_nonoverlapping(message.as_ptr(), GlobalLock(block) as *mut u8, message.len());
        let _ = GlobalUnlock(block);
        Body(block.0 as usize, message.len())
    });
    let completed = body.map_err(Into::into)
        .and_then(|body| respond(args, deferral, 502, "Application error", "Content-Type: text/plain\r\n", body));
    if completed.is_err() { unsafe { let _ = deferral.Complete(); } }
}

fn read_frames(sender: Sender<Incoming>, window: usize) {
    let wake = || unsafe { let _ = PostMessageW(Some(HWND(window as _)), WM_INCOMING, WPARAM(0), LPARAM(0)); };
    let mut input = io::stdin().lock();
    let read = (|| -> Result<(), String> {
        loop {
            let mut lengths = [0u8; 8];
            input.read_exact(&mut lengths).map_err(|error| error.to_string())?;
            let header_length = u32::from_le_bytes(lengths[..4].try_into().unwrap()) as usize;
            let body_length = u32::from_le_bytes(lengths[4..].try_into().unwrap()) as usize;
            if header_length > 1_048_576 || body_length > RESPONSE_LIMIT {
                return Err("The application response is too large.".into());
            }
            let mut header = vec![0u8; header_length];
            input.read_exact(&mut header).map_err(|error| error.to_string())?;
            let body = Body::read(&mut input, body_length).map_err(|error| error.to_string())?;
            let message: Value = serde_json::from_slice(&header).map_err(|error| error.to_string())?;
            let close = message["type"] == "close";
            if sender.send(Incoming::Frame(Frame(message, body))).is_err() { return Ok(()); }
            wake();
            if close { return Ok(()); }
        }
    })();
    if let Err(message) = read { eprintln!("{message}"); }
    let _ = sender.send(Incoming::Stopped);
    wake();
}

fn receive(shell: &'static Shell) {
    while let Ok(incoming) = shell.incoming.try_recv() {
        match incoming {
            Incoming::Frame(Frame(message, body)) => match message["type"].as_str() {
                Some("response") => {
                    let Some(waiting) = message["id"].as_u64().and_then(|id| shell.pending.borrow_mut().remove(&id)) else { continue };
                    let status = message["status"].as_i64().unwrap_or(0) as i32;
                    let completed = respond(&waiting.args, &waiting.deferral, status,
                        message["statusText"].as_str().unwrap_or(""), message["headers"].as_str().unwrap_or(""), body);
                    if let Err(error) = completed { respond_error(&waiting.args, &waiting.deferral, &error.message()); }
                }
                Some("close") => unsafe { let _ = PostMessageW(Some(shell.window.get()), WM_CLOSE, WPARAM(0), LPARAM(0)); },
                // The harness supplies these commands through the parent pipe.
                // Web content cannot send them or gain access to the pipe.
                Some("evaluate") | Some("capture") => inspect(message),
                _ => {}
            },
            Incoming::Stopped => {
                let stopped: Vec<_> = shell.pending.borrow_mut().drain().collect();
                for (_, waiting) in stopped {
                    respond_error(&waiting.args, &waiting.deferral, "The application process stopped.");
                }
                unsafe { let _ = PostMessageW(Some(shell.window.get()), WM_CLOSE, WPARAM(0), LPARAM(0)); }
            }
        }
    }
}

fn inspect(message: Value) {
    let id = message["id"].clone();
    let reply = {
        let id = id.clone();
        move |result: windows::core::Result<Value>| send(&match result {
            Ok(result) => json!({ "type": "inspection", "id": id, "result": result }),
            Err(error) => json!({ "type": "inspection", "id": id, "error": error.message() }),
        })
    };
    let Some(view) = view() else { return reply(Err(E_UNEXPECTED.into())) };
    let started = unsafe {
        if message["type"] == "capture" {
            let path = HSTRING::from(message["path"].as_str().unwrap_or(""));
            SHCreateStreamOnFileEx(&path, (STGM_CREATE | STGM_WRITE).0, 0x80 /* FILE_ATTRIBUTE_NORMAL */, true, None).and_then(|file| {
                let done = reply.clone();
                let target = file.clone();
                view.webview.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &file,
                    &CapturePreviewCompletedHandler::create(Box::new(move |result| {
                        drop(target); // Close the file before the parent reads it.
                        done(result.map(|_| Value::String("null".into())));
                        Ok(())
                    })))
            })
        } else {
            let done = reply.clone();
            view.webview.ExecuteScript(&HSTRING::from(message["script"].as_str().unwrap_or("")),
                &ExecuteScriptCompletedHandler::create(Box::new(move |result, value| {
                    done(result.map(|_| Value::String(value)));
                    Ok(())
                })))
        }
    };
    if let Err(error) = started { reply(Err(error)); }
}

fn resize(window: HWND) {
    let Some(view) = view() else { return };
    unsafe {
        let minimized = IsIconic(window).as_bool();
        if !minimized {
            let mut bounds = RECT::default();
            if GetClientRect(window, &mut bounds).is_ok() { let _ = view.controller.SetBounds(bounds); }
        }
        // Let Chromium discard caches while minimized without suspending verification work.
        if let Ok(webview) = view.webview.cast::<ICoreWebView2_19>() {
            let _ = webview.SetMemoryUsageTargetLevel(if minimized { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL });
        }
    }
}

fn expire(shell: &'static Shell) {
    let now = Instant::now();
    let expired: Vec<u64> = shell.pending.borrow().iter().filter(|(_, waiting)| waiting.deadline <= now).map(|(id, _)| *id).collect();
    for id in expired {
        let Some(waiting) = shell.pending.borrow_mut().remove(&id) else { continue };
        respond_error(&waiting.args, &waiting.deferral, "The application request timed out.");
    }
    if shell.pending.borrow().is_empty() { unsafe { let _ = KillTimer(Some(shell.window.get()), EXPIRY_TIMER); } }
}

extern "system" fn window_procedure(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        match message {
            WM_SIZE => { resize(window); LRESULT(0) }
            WM_MOVE | WM_MOVING => {
                if let Some(view) = view() { let _ = view.controller.NotifyParentWindowPositionChanged(); }
                DefWindowProcW(window, message, wparam, lparam)
            }
            WM_SETFOCUS => {
                if let Some(view) = view() { let _ = view.controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC); }
                LRESULT(0)
            }
            WM_GETMINMAXINFO => {
                let limits = &mut *(lparam.0 as *mut MINMAXINFO);
                limits.ptMinTrackSize = POINT { x: 900, y: 600 };
                LRESULT(0)
            }
            WM_DPICHANGED => {
                let suggested = &*(lparam.0 as *const RECT);
                let _ = SetWindowPos(window, None, suggested.left, suggested.top, suggested.right - suggested.left,
                    suggested.bottom - suggested.top, SWP_NOZORDER | SWP_NOACTIVATE);
                LRESULT(0)
            }
            WM_INCOMING => { if let Some(shell) = shell() { receive(shell); } LRESULT(0) }
            WM_TIMER if wparam.0 == EXPIRY_TIMER => { if let Some(shell) = shell() { expire(shell); } LRESULT(0) }
            WM_DESTROY => {
                if let Some(shell) = shell() {
                    let view = shell.view.borrow_mut().take();
                if let Some(view) = view { let _ = view.controller.Close(); }
                    PostQuitMessage(shell.exit_code.get());
                }
                LRESULT(0)
            }
            _ => DefWindowProcW(window, message, wparam, lparam),
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args_os().map(|arg| arg.to_string_lossy().into_owned()).collect();
    if args.len() != 4 { std::process::exit(2); }
    let (incoming_sender, incoming) = channel();
    let shell: &'static Shell = Box::leak(Box::new(Shell {
        window: Cell::new(HWND::default()),
        title: HSTRING::from(&args[1]),
        origin: origin_of(&args[2]).unwrap_or_else(|| args[2].clone()),
        profile: HSTRING::from(&args[3]),
        view: RefCell::new(None),
        pending: RefCell::new(HashMap::new()),
        sequence: Cell::new(0),
        signing_in: Cell::new(false),
        exit_code: Cell::new(0),
        incoming,
        sender: RefCell::new(Some(incoming_sender)),
    }));
    SHELL.with(|cell| { let _ = cell.set(shell); });
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let instance: HINSTANCE = GetModuleHandleW(None).unwrap_or_default().into();
        let icon_id = PCWSTR(1 as _);
        let class = WNDCLASSEXW {
            cbSize: size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(window_procedure),
            hInstance: instance,
            hIcon: LoadIconW(Some(instance), icon_id).unwrap_or_default(),
            hIconSm: LoadImageW(Some(instance), icon_id, IMAGE_ICON, GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), LR_DEFAULTCOLOR)
                .map(|icon| HICON(icon.0)).unwrap_or_default(),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            hbrBackground: HBRUSH((COLOR_WINDOW.0 + 1) as _),
            lpszClassName: windows::core::w!("BeaverWebViewShell"),
            ..Default::default()
        };
        RegisterClassExW(&class);
        // Centered on the display under the pointer, like a centered form.
        let (width, height) = (1440, 960);
        let mut pointer = POINT::default();
        let _ = GetCursorPos(&mut pointer);
        let mut monitor = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        let _ = GetMonitorInfoW(MonitorFromPoint(pointer, MONITOR_DEFAULTTONEAREST), &mut monitor);
        let area = monitor.rcWork;
        let x = (area.left + (area.right - area.left - width) / 2).max(area.left);
        let y = (area.top + (area.bottom - area.top - height) / 2).max(area.top);
        let window = match CreateWindowExW(WINDOW_EX_STYLE::default(), class.lpszClassName, &shell.title, WS_OVERLAPPEDWINDOW,
            x, y, width, height, None, None, Some(instance), None) {
            Ok(window) => window,
            Err(error) => { eprintln!("{}", error.message()); std::process::exit(1); }
        };
        shell.window.set(window);
        let _ = ShowWindow(window, SW_SHOWNORMAL);
        let _ = UpdateWindow(window);
        start(shell);
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        std::process::exit(message.wParam.0 as i32);
    }
}
