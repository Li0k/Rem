#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
#[cfg(windows)]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(windows)]
use std::time::Instant;
use std::{
    collections::{HashSet, VecDeque},
    sync::{Arc, Mutex},
};

#[cfg(windows)]
const INPUT_QUEUE_CAPACITY: usize = 16_384;
const MAX_DRAIN_BATCH: usize = 1_024;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
#[serde(tag = "kind", rename_all = "snake_case")]
enum NativeInputEvent {
    Move { t: f64, dx: i32, dy: i32 },
    ButtonDown { t: f64, button: u8 },
    ButtonUp { t: f64, button: u8 },
}

#[derive(Debug)]
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
struct EventQueue {
    events: VecDeque<NativeInputEvent>,
    capacity: usize,
    dropped: u64,
    raw_packets: u64,
    emitted_events: u64,
    movement_packets: u64,
    button_events: u64,
    peak_pending: usize,
    devices: HashSet<usize>,
    first_packet_ms: Option<f64>,
    last_packet_ms: Option<f64>,
    first_event_ms: Option<f64>,
    last_event_ms: Option<f64>,
}

impl EventQueue {
    #[cfg_attr(not(any(windows, test)), allow(dead_code))]
    fn with_capacity(capacity: usize) -> Self {
        Self {
            events: VecDeque::with_capacity(capacity),
            capacity,
            dropped: 0,
            raw_packets: 0,
            emitted_events: 0,
            movement_packets: 0,
            button_events: 0,
            peak_pending: 0,
            devices: HashSet::with_capacity(8),
            first_packet_ms: None,
            last_packet_ms: None,
            first_event_ms: None,
            last_event_ms: None,
        }
    }

    #[cfg_attr(not(any(windows, test)), allow(dead_code))]
    fn record_raw_packet(&mut self, t: f64, device: Option<usize>) {
        self.raw_packets = self.raw_packets.saturating_add(1);
        self.first_packet_ms.get_or_insert(t);
        self.last_packet_ms = Some(t);
        if let Some(device) = device.filter(|device| *device != 0) {
            self.devices.insert(device);
        }
    }

    #[cfg_attr(not(any(windows, test)), allow(dead_code))]
    fn push(&mut self, event: NativeInputEvent) {
        let t = match &event {
            NativeInputEvent::Move { t, .. } => {
                self.movement_packets = self.movement_packets.saturating_add(1);
                *t
            }
            NativeInputEvent::ButtonDown { t, .. } | NativeInputEvent::ButtonUp { t, .. } => {
                self.button_events = self.button_events.saturating_add(1);
                *t
            }
        };
        self.first_event_ms.get_or_insert(t);
        self.last_event_ms = Some(t);
        if self.events.len() == self.capacity {
            self.dropped = self.dropped.saturating_add(1);
        } else {
            self.events.push_back(event);
            self.emitted_events = self.emitted_events.saturating_add(1);
            self.peak_pending = self.peak_pending.max(self.events.len());
        }
    }

    fn drain(&mut self, limit: usize) -> NativeInputBatch {
        let count = limit.min(self.events.len());
        let events = self.events.drain(..count).collect();
        NativeInputBatch {
            events,
            diagnostics: self.diagnostics(),
        }
    }

    fn diagnostics(&self) -> NativeInputDiagnostics {
        NativeInputDiagnostics {
            raw_packets: self.raw_packets,
            emitted_events: self.emitted_events,
            movement_packets: self.movement_packets,
            button_events: self.button_events,
            device_count: self.devices.len(),
            peak_pending: self.peak_pending,
            pending: self.events.len(),
            dropped: self.dropped,
            first_packet_ms: self.first_packet_ms,
            last_packet_ms: self.last_packet_ms,
            first_event_ms: self.first_event_ms,
            last_event_ms: self.last_event_ms,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeInputDiagnostics {
    raw_packets: u64,
    emitted_events: u64,
    movement_packets: u64,
    button_events: u64,
    device_count: usize,
    peak_pending: usize,
    pending: usize,
    dropped: u64,
    first_packet_ms: Option<f64>,
    last_packet_ms: Option<f64>,
    first_event_ms: Option<f64>,
    last_event_ms: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeInputBatch {
    events: Vec<NativeInputEvent>,
    #[serde(flatten)]
    diagnostics: NativeInputDiagnostics,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeInputStart {
    backend: &'static str,
    native: bool,
    unadjusted: bool,
    capacity: usize,
    epoch_elapsed_ms: f64,
    registered: bool,
    session_id: u64,
}

#[derive(Clone, Default)]
struct NativeInputManager {
    queue: Arc<Mutex<Option<(u64, Arc<Mutex<EventQueue>>)>>>,
    #[cfg(windows)]
    hook: Arc<Mutex<Option<(u64, windows_input::WindowsHook)>>>,
    #[cfg(windows)]
    generation: Arc<AtomicU64>,
}

#[cfg(windows)]
mod windows_input {
    use super::*;
    use std::mem::{size_of, MaybeUninit};
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        UI::{
            Input::{
                GetRawInputData, GetRegisteredRawInputDevices, RegisterRawInputDevices, HRAWINPUT,
                MOUSE_MOVE_ABSOLUTE, RAWINPUT, RAWINPUTDEVICE, RIDEV_REMOVE, RID_INPUT,
                RIM_TYPEMOUSE,
            },
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{
                RI_MOUSE_BUTTON_1_DOWN, RI_MOUSE_BUTTON_1_UP, RI_MOUSE_BUTTON_2_DOWN,
                RI_MOUSE_BUTTON_2_UP, RI_MOUSE_BUTTON_3_DOWN, RI_MOUSE_BUTTON_3_UP,
                RI_MOUSE_BUTTON_4_DOWN, RI_MOUSE_BUTTON_4_UP, RI_MOUSE_BUTTON_5_DOWN,
                RI_MOUSE_BUTTON_5_UP, WM_INPUT,
            },
        },
    };

    const SUBCLASS_ID: usize = 0x5245_4d49; // "REMI"

    struct HookContext {
        queue: Arc<Mutex<EventQueue>>,
        epoch: Instant,
    }

    struct PreviousMouseRegistration {
        flags: u32,
        hwnd_target: isize,
    }

    pub(super) struct WindowsHook {
        hwnd: isize,
        context: Option<Box<HookContext>>,
        previous_registration: Option<PreviousMouseRegistration>,
    }

    fn current_mouse_registration() -> Result<Option<PreviousMouseRegistration>, String> {
        let item_size = size_of::<RAWINPUTDEVICE>() as u32;
        let mut count = 0;
        let first =
            unsafe { GetRegisteredRawInputDevices(std::ptr::null_mut(), &mut count, item_size) };
        if first == u32::MAX {
            return Err(format!(
                "GetRegisteredRawInputDevices(size) failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        if count == 0 {
            return Ok(None);
        }
        let mut devices = vec![unsafe { std::mem::zeroed::<RAWINPUTDEVICE>() }; count as usize];
        let copied =
            unsafe { GetRegisteredRawInputDevices(devices.as_mut_ptr(), &mut count, item_size) };
        if copied == u32::MAX {
            return Err(format!(
                "GetRegisteredRawInputDevices(data) failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(devices
            .into_iter()
            .take(copied as usize)
            .find(|device| device.usUsagePage == 0x01 && device.usUsage == 0x02)
            .map(|device| PreviousMouseRegistration {
                flags: device.dwFlags,
                hwnd_target: device.hwndTarget as isize,
            }))
    }

    // The callback never owns dwrefdata. WindowsHook keeps the Box alive until
    // RemoveWindowSubclass has completed on the window thread.
    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _subclass_id: usize,
        refdata: usize,
    ) -> LRESULT {
        if message == WM_INPUT && refdata != 0 {
            let context = unsafe { &*(refdata as *const HookContext) };
            unsafe { capture_raw_input(context, lparam as HRAWINPUT) };
        }
        // WM_INPUT cleanup for foreground input is performed by the default
        // procedure, so it must always remain in the chain.
        unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
    }

    unsafe fn capture_raw_input(context: &HookContext, handle: HRAWINPUT) {
        let mut raw = MaybeUninit::<RAWINPUT>::uninit();
        let mut size = size_of::<RAWINPUT>() as u32;
        let copied = unsafe {
            GetRawInputData(
                handle,
                RID_INPUT,
                raw.as_mut_ptr().cast(),
                &mut size,
                size_of::<windows_sys::Win32::UI::Input::RAWINPUTHEADER>() as u32,
            )
        };
        if copied == u32::MAX || copied < size_of::<RAWINPUT>() as u32 {
            return;
        }
        let raw = unsafe { raw.assume_init() };
        if raw.header.dwType != RIM_TYPEMOUSE {
            return;
        }
        let device = (!raw.header.hDevice.is_null()).then_some(raw.header.hDevice as usize);
        let mouse = unsafe { raw.data.mouse };
        let t = context.epoch.elapsed().as_secs_f64() * 1_000.0;
        let Ok(mut queue) = context.queue.lock() else {
            return;
        };
        queue.record_raw_packet(t, device);
        // Absolute packets (for example some remote-desktop or tablet paths)
        // are not relative mouse counts and must not be mixed into this backend.
        if mouse.usFlags & MOUSE_MOVE_ABSOLUTE != 0 {
            return;
        }
        let button_flags = unsafe { mouse.Anonymous.Anonymous.usButtonFlags } as u32;
        if mouse.lLastX != 0 || mouse.lLastY != 0 {
            queue.push(NativeInputEvent::Move {
                t,
                dx: mouse.lLastX,
                dy: mouse.lLastY,
            });
        }
        for (down, up, button) in [
            (RI_MOUSE_BUTTON_1_DOWN, RI_MOUSE_BUTTON_1_UP, 0),
            (RI_MOUSE_BUTTON_2_DOWN, RI_MOUSE_BUTTON_2_UP, 2),
            (RI_MOUSE_BUTTON_3_DOWN, RI_MOUSE_BUTTON_3_UP, 1),
            (RI_MOUSE_BUTTON_4_DOWN, RI_MOUSE_BUTTON_4_UP, 3),
            (RI_MOUSE_BUTTON_5_DOWN, RI_MOUSE_BUTTON_5_UP, 4),
        ] {
            if button_flags & down != 0 {
                queue.push(NativeInputEvent::ButtonDown { t, button });
            }
            if button_flags & up != 0 {
                queue.push(NativeInputEvent::ButtonUp { t, button });
            }
        }
    }

    pub(super) fn install(
        hwnd: HWND,
        queue: Arc<Mutex<EventQueue>>,
    ) -> Result<WindowsHook, String> {
        // Tao already owns the process-wide mouse Raw Input registration.
        // Windows keeps only the most recent registration per device class, so
        // this must be restored when the measurement session ends.
        let previous_registration = current_mouse_registration()?;
        let context = Box::new(HookContext {
            queue,
            epoch: Instant::now(),
        });
        let context_ptr = (&*context as *const HookContext) as usize;
        if unsafe { SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, context_ptr) } == 0 {
            return Err(format!(
                "SetWindowSubclass failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let device = RAWINPUTDEVICE {
            usUsagePage: 0x01,
            usUsage: 0x02,
            // Do not suppress legacy messages: WebView2 still uses them for
            // Pointer Lock/capture state. JS has no DOM mouse listeners in the
            // native session, so those messages cannot be double-counted.
            dwFlags: 0,
            hwndTarget: hwnd,
        };
        if unsafe { RegisterRawInputDevices(&device, 1, size_of::<RAWINPUTDEVICE>() as u32) } == 0 {
            let registration_error = std::io::Error::last_os_error();
            let removed =
                unsafe { RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID) } != 0;
            if !removed {
                // Do not free a refdata target unless the callback is known to
                // be detached. This failure path intentionally leaks instead
                // of risking a use-after-free.
                Box::leak(context);
            }
            return Err(format!(
                "RegisterRawInputDevices failed: {}",
                registration_error
            ));
        }
        Ok(WindowsHook {
            hwnd: hwnd as isize,
            context: Some(context),
            previous_registration,
        })
    }

    impl WindowsHook {
        pub(super) fn elapsed_ms(&self) -> f64 {
            self.context.as_ref().map_or(0.0, |context| {
                context.epoch.elapsed().as_secs_f64() * 1_000.0
            })
        }

        pub(super) fn cleanup(&mut self) -> Result<(), String> {
            if self.context.is_none() {
                return Ok(());
            }
            let hwnd = self.hwnd as HWND;
            // Stop routing WM_INPUT to this HWND before removing the callback.
            // Restore Tao's process-wide registration when one existed. Keep
            // both resources owned by this hook on failure so a later stop or
            // startup attempt can retry instead of silently losing the prior
            // registration.
            let registration = self.previous_registration.as_ref().map_or(
                RAWINPUTDEVICE {
                    usUsagePage: 0x01,
                    usUsage: 0x02,
                    dwFlags: RIDEV_REMOVE,
                    hwndTarget: std::ptr::null_mut(),
                },
                |previous| RAWINPUTDEVICE {
                    usUsagePage: 0x01,
                    usUsage: 0x02,
                    dwFlags: previous.flags,
                    hwndTarget: previous.hwnd_target as HWND,
                },
            );
            let restored = unsafe {
                RegisterRawInputDevices(&registration, 1, size_of::<RAWINPUTDEVICE>() as u32)
            };
            if restored == 0 {
                return Err(format!(
                    "RegisterRawInputDevices restore failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let removed =
                unsafe { RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID) } != 0;
            if !removed {
                return Err(format!(
                    "RemoveWindowSubclass failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            self.context.take();
            self.previous_registration.take();
            Ok(())
        }
    }

    impl Drop for WindowsHook {
        fn drop(&mut self) {
            if let Err(error) = self.cleanup() {
                eprintln!("native input cleanup failed: {error}");
            }
        }
    }
}

#[cfg(windows)]
fn start_native_input_on_window_thread(
    window: &tauri::WebviewWindow,
    manager: &NativeInputManager,
) -> Result<NativeInputStart, String> {
    let mut hook = manager
        .hook
        .lock()
        .map_err(|_| "native input state poisoned")?;
    if let Some((_, stale)) = hook.as_mut() {
        stale
            .cleanup()
            .map_err(|error| format!("native input cleanup failed: {error}"))?;
    }
    hook.take();
    manager
        .queue
        .lock()
        .map_err(|_| "native input state poisoned")?
        .take();
    let session_id = manager.generation.fetch_add(1, Ordering::AcqRel) + 1;
    let queue = Arc::new(Mutex::new(EventQueue::with_capacity(INPUT_QUEUE_CAPACITY)));
    // Tauri's HWND is the actual top-level WebviewWindow HWND. Both the invoke
    // command and the window procedure run on its UI thread.
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as _;
    let installed = windows_input::install(hwnd, Arc::clone(&queue))?;
    let epoch_elapsed_ms = installed.elapsed_ms();
    *manager
        .queue
        .lock()
        .map_err(|_| "native input state poisoned")? = Some((session_id, queue));
    *hook = Some((session_id, installed));
    Ok(NativeInputStart {
        backend: "windows-wm-input",
        native: true,
        unadjusted: true,
        capacity: INPUT_QUEUE_CAPACITY,
        epoch_elapsed_ms,
        registered: true,
        session_id,
    })
}

#[cfg(windows)]
#[tauri::command]
async fn start_native_input(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, NativeInputManager>,
) -> Result<NativeInputStart, String> {
    let manager = state.inner().clone();
    let task_window = window.clone();
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    window
        .run_on_main_thread(move || {
            let result = start_native_input_on_window_thread(&task_window, &manager);
            let _ = sender.blocking_send(result);
        })
        .map_err(|error| format!("failed to schedule native input start: {error}"))?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "native input start task was cancelled".to_string())?
}

#[cfg(not(windows))]
#[tauri::command]
async fn start_native_input(
    _window: tauri::WebviewWindow,
    _state: tauri::State<'_, NativeInputManager>,
) -> Result<NativeInputStart, String> {
    Err("WM_INPUT is only available on Windows".into())
}

#[tauri::command]
fn drain_native_input(
    state: tauri::State<'_, NativeInputManager>,
    session_id: u64,
    limit: Option<usize>,
) -> Result<NativeInputBatch, String> {
    let queue = state
        .queue
        .lock()
        .map_err(|_| "native input state poisoned")?;
    let (active_session, queue) = queue.as_ref().ok_or("native input is not active")?;
    if *active_session != session_id {
        return Err(format!(
            "native input session mismatch: requested {session_id}, active {active_session}"
        ));
    }
    let mut queue = queue.lock().map_err(|_| "native input queue poisoned")?;
    Ok(queue.drain(limit.unwrap_or(MAX_DRAIN_BATCH).clamp(1, MAX_DRAIN_BATCH)))
}

#[cfg(windows)]
fn stop_native_input_on_window_thread(
    manager: &NativeInputManager,
    session_id: u64,
) -> Result<NativeInputBatch, String> {
    let mut hook = manager
        .hook
        .lock()
        .map_err(|_| "native input state poisoned")?;
    let active_session = hook
        .as_ref()
        .map(|(active_session, _)| *active_session)
        .ok_or("native input is not active")?;
    if active_session != session_id {
        return Err(format!(
            "native input session mismatch: requested {session_id}, active {active_session}"
        ));
    }
    if let Some((_, active_hook)) = hook.as_mut() {
        active_hook.cleanup()?;
    }
    hook.take();
    let mut queue = manager
        .queue
        .lock()
        .map_err(|_| "native input state poisoned")?;
    let active_session = queue
        .as_ref()
        .map(|(active_session, _)| *active_session)
        .ok_or("native input queue is not active")?;
    if active_session != session_id {
        return Err(format!(
            "native input queue session mismatch: requested {session_id}, active {active_session}"
        ));
    }
    let (_, queue) = queue.take().expect("active queue checked above");
    let mut queue = queue.lock().map_err(|_| "native input queue poisoned")?;
    let remaining = queue.events.len();
    Ok(queue.drain(remaining))
}

#[cfg(windows)]
#[tauri::command]
async fn stop_native_input(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, NativeInputManager>,
    session_id: u64,
) -> Result<NativeInputBatch, String> {
    let manager = state.inner().clone();
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    window
        .run_on_main_thread(move || {
            let result = stop_native_input_on_window_thread(&manager, session_id);
            let _ = sender.blocking_send(result);
        })
        .map_err(|error| format!("failed to schedule native input stop: {error}"))?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "native input stop task was cancelled".to_string())?
}

#[cfg(not(windows))]
#[tauri::command]
async fn stop_native_input(
    _window: tauri::WebviewWindow,
    _state: tauri::State<'_, NativeInputManager>,
    _session_id: u64,
) -> Result<NativeInputBatch, String> {
    Err("WM_INPUT is only available on Windows".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(NativeInputManager::default())
        .invoke_handler(tauri::generate_handler![
            start_native_input,
            drain_native_input,
            stop_native_input
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mouse Migration Lab");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_queue_preserves_order_and_reports_overflow() {
        let mut queue = EventQueue::with_capacity(2);
        queue.push(NativeInputEvent::Move {
            t: 1.0,
            dx: 2,
            dy: 3,
        });
        queue.push(NativeInputEvent::ButtonDown { t: 2.0, button: 0 });
        queue.push(NativeInputEvent::ButtonUp { t: 3.0, button: 0 });

        let batch = queue.drain(8);
        assert_eq!(batch.diagnostics.dropped, 1);
        assert_eq!(batch.diagnostics.pending, 0);
        assert_eq!(batch.diagnostics.emitted_events, 2);
        assert_eq!(batch.diagnostics.peak_pending, 2);
        assert_eq!(batch.events.len(), 2);
        assert_eq!(
            batch.events[0],
            NativeInputEvent::Move {
                t: 1.0,
                dx: 2,
                dy: 3
            }
        );
        assert_eq!(
            batch.events[1],
            NativeInputEvent::ButtonDown { t: 2.0, button: 0 }
        );
    }

    #[test]
    fn draining_is_bounded_without_resetting_dropped_total() {
        let mut queue = EventQueue::with_capacity(3);
        for t in 0..3 {
            queue.push(NativeInputEvent::Move {
                t: t as f64,
                dx: 1,
                dy: -1,
            });
        }
        let first = queue.drain(2);
        assert_eq!(first.events.len(), 2);
        assert_eq!(first.diagnostics.pending, 1);
        let second = queue.drain(2);
        assert_eq!(second.events.len(), 1);
        assert_eq!(second.diagnostics.dropped, 0);
    }

    #[test]
    fn diagnostics_count_packets_events_peak_and_distinct_non_null_devices() {
        let mut queue = EventQueue::with_capacity(4);
        queue.record_raw_packet(1.0, Some(0x111));
        queue.push(NativeInputEvent::Move {
            t: 1.0,
            dx: 4,
            dy: -2,
        });
        queue.record_raw_packet(2.0, Some(0x111));
        queue.push(NativeInputEvent::ButtonDown { t: 2.0, button: 0 });
        queue.record_raw_packet(3.0, Some(0x222));
        queue.record_raw_packet(4.0, None);

        let diagnostics = queue.diagnostics();
        assert_eq!(diagnostics.raw_packets, 4);
        assert_eq!(diagnostics.emitted_events, 2);
        assert_eq!(diagnostics.movement_packets, 1);
        assert_eq!(diagnostics.button_events, 1);
        assert_eq!(diagnostics.device_count, 2);
        assert_eq!(diagnostics.peak_pending, 2);
        assert_eq!(diagnostics.first_packet_ms, Some(1.0));
        assert_eq!(diagnostics.last_packet_ms, Some(4.0));
        assert_eq!(diagnostics.first_event_ms, Some(1.0));
        assert_eq!(diagnostics.last_event_ms, Some(2.0));
    }
}
