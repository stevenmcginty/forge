/**
 * The C# half of ./desktop-hands.ts, as a string: PowerShell compiles it once
 * with Add-Type when the helper starts, then hands the process to
 * `ForgeHands.Run()`, which reads one JSON request per stdin line and writes
 * one JSON answer per stdout line until stdin closes.
 *
 * Kept in its own file because it is a page of another language; nothing here
 * runs in Node. Every Win32 and UI Automation call Forge makes on Steve's
 * desktop is in this one string, so it can be audited by reading.
 */
export const HANDS_CSHARP = String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;

public static class ForgeHands {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v);

  const int GWL_EXSTYLE = -20;
  const int WS_EX_TOOLWINDOW = 0x80;
  const uint GA_ROOT = 2;
  const int DWMWA_CLOAKED = 14;
  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint MOUSEEVENTF_LEFTDOWN = 0x2, MOUSEEVENTF_LEFTUP = 0x4;
  const uint KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4;
  const ushort VK_RETURN = 0x0D, VK_TAB = 0x09, VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12;

  static List<AutomationElement> refs = new List<AutomationElement>();
  static IntPtr refsWindow = IntPtr.Zero;
  static Dictionary<uint, string> appNames = new Dictionary<uint, string>();

  /* ------------------------------------------------------------ the loop */

  public static void Run() {
    // Physical pixels everywhere: rectangles, SetCursorPos and the screen size
    // must all be in the same units as the picture main takes.
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { try { SetProcessDPIAware(); } catch (Exception) { } }
    var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    output.AutoFlush = true;
    var json = new JavaScriptSerializer();
    json.MaxJsonLength = int.MaxValue;
    output.WriteLine("{\"ready\":true}");
    string line;
    while ((line = input.ReadLine()) != null) {
      if (line.Trim().Length == 0) continue;
      object id = null;
      var reply = new Dictionary<string, object>();
      try {
        var req = json.Deserialize<Dictionary<string, object>>(line);
        id = req.ContainsKey("id") ? req["id"] : null;
        var args = (req.ContainsKey("args") ? req["args"] as Dictionary<string, object> : null) ?? new Dictionary<string, object>();
        reply["result"] = Dispatch(Str(req, "op"), args);
        reply["ok"] = true;
      } catch (Exception e) {
        while ((e is AggregateException || e is System.Reflection.TargetInvocationException) && e.InnerException != null) e = e.InnerException;
        reply["ok"] = false;
        reply["error"] = e is ElementNotAvailableException ? "That control is gone from the window now (the window changed). Read the window again." : e.Message;
      }
      reply["id"] = id;
      output.WriteLine(json.Serialize(reply));
    }
  }

  static object Dispatch(string op, Dictionary<string, object> a) {
    switch (op) {
      case "screen": return new Dictionary<string, object> { { "width", GetSystemMetrics(0) }, { "height", GetSystemMetrics(1) } };
      case "windows": return Windows(Pids(a));
      case "read": return Read(Handle(a), Int(a, "max", 150));
      case "click_ref": return ClickRef(Int(a, "ref", 0));
      case "click_xy": return ClickXY(Int(a, "x", 0), Int(a, "y", 0), Pids(a));
      case "type": return TypeText(Int(a, "ref", 0), Handle(a), Str(a, "text"), Bool(a, "enter"));
      case "keys": return Keys(Handle(a), a.ContainsKey("keys") ? a["keys"] as IEnumerable : null);
      default: throw new Exception("unknown op " + op);
    }
  }

  /* ------------------------------------------------------------- windows */

  static string AppOf(uint pid) {
    string name;
    if (appNames.TryGetValue(pid, out name)) return name;
    try { name = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { name = "?"; }
    appNames[pid] = name;
    return name;
  }

  static string TitleOf(IntPtr h) {
    var sb = new StringBuilder(512);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString().Trim();
  }

  static List<object> Windows(HashSet<uint> own) {
    var list = new List<object>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      if ((GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true;
      int cloaked;
      if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return true;
      string title = TitleOf(h);
      if (title.Length == 0) return true;
      var cls = new StringBuilder(256);
      GetClassName(h, cls, cls.Capacity);
      if (cls.ToString() == "Progman" || cls.ToString() == "WorkerW") return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (own.Contains(pid)) return true;
      list.Add(new Dictionary<string, object> {
        { "hwnd", h.ToInt64() }, { "pid", pid }, { "app", AppOf(pid) }, { "title", title }, { "minimised", IsIconic(h) }
      });
      return true;
    }, IntPtr.Zero);
    return list;
  }

  /** Bring a window forward. True when it is the foreground window afterwards. */
  static bool Focus(IntPtr h) {
    if (h == IntPtr.Zero || !IsWindow(h)) return false;
    if (IsIconic(h)) ShowWindow(h, 9);
    if (GetForegroundWindow() == h) return true;
    uint ignored;
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
    uint me = GetCurrentThreadId();
    bool attached = fg != 0 && fg != me && AttachThreadInput(me, fg, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, fg, false);
    for (int i = 0; i < 10 && GetForegroundWindow() != h; i++) Thread.Sleep(30);
    return GetForegroundWindow() == h;
  }

  /* ---------------------------------------------------------------- read */

  static readonly ControlType[] Kinds = {
    ControlType.Edit, ControlType.Button, ControlType.CheckBox, ControlType.RadioButton, ControlType.ComboBox,
    ControlType.Hyperlink, ControlType.ListItem, ControlType.MenuItem, ControlType.TabItem
  };

  static AutomationElementCollection Find(AutomationElement root) {
    var kinds = new List<Condition>();
    foreach (var k in Kinds) kinds.Add(new PropertyCondition(AutomationElement.ControlTypeProperty, k));
    var cond = new AndCondition(new PropertyCondition(AutomationElement.IsOffscreenProperty, false), new OrCondition(kinds.ToArray()));
    var cr = new CacheRequest();
    cr.AutomationElementMode = AutomationElementMode.Full;
    cr.TreeScope = TreeScope.Element;
    cr.Add(AutomationElement.NameProperty);
    cr.Add(AutomationElement.HelpTextProperty);
    cr.Add(AutomationElement.ControlTypeProperty);
    cr.Add(AutomationElement.BoundingRectangleProperty);
    cr.Add(AutomationElement.IsEnabledProperty);
    cr.Add(AutomationElement.IsPasswordProperty);
    cr.Add(ValuePattern.ValueProperty);
    cr.Add(TogglePattern.ToggleStateProperty);
    cr.Add(SelectionItemPattern.IsSelectedProperty);
    cr.Add(ExpandCollapsePattern.ExpandCollapseStateProperty);
    using (cr.Activate()) return root.FindAll(TreeScope.Descendants, cond);
  }

  /** A Chromium window whose page has not been put in the accessibility tree yet. */
  static bool PageMissing(AutomationElement root) {
    var doc = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
    return doc == null || TreeWalker.ControlViewWalker.GetFirstChild(doc) == null;
  }

  static object Cached(AutomationElement el, AutomationProperty p) {
    try { return el.GetCachedPropertyValue(p, true); } catch (Exception) { return AutomationElement.NotSupported; }
  }

  static object Read(IntPtr h, int max) {
    if (!IsWindow(h)) throw new Exception("That window has closed.");
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    string app = AppOf(pid);
    var root = AutomationElement.FromHandle(h);
    bool waited = false;
    bool chromium = Array.IndexOf(new[] { "chrome", "msedge", "brave", "vivaldi", "opera" }, app.ToLowerInvariant()) >= 0;
    // Chromium builds its accessibility tree only once a client asks, so the
    // first look can be the frame alone. One second, one more look.
    if (chromium && !IsIconic(h) && PageMissing(root)) { Thread.Sleep(1000); waited = true; }
    var found = Find(root);
    refs = new List<AutomationElement>();
    refsWindow = h;
    var items = new List<object>();
    int total = 0;
    foreach (AutomationElement el in found) {
      Rect r;
      try { r = el.Cached.BoundingRectangle; } catch (Exception) { continue; }
      if (r.IsEmpty || r.Width < 1 || r.Height < 1) continue;
      total++;
      if (items.Count >= max) continue;
      refs.Add(el);
      items.Add(Describe(el, refs.Count));
    }
    return new Dictionary<string, object> {
      { "title", TitleOf(h) }, { "app", app }, { "minimised", IsIconic(h) }, { "items", items }, { "total", total }, { "waited", waited }
    };
  }

  static Dictionary<string, object> Describe(AutomationElement el, int n) {
    var ct = el.Cached.ControlType;
    string name = el.Cached.Name ?? "";
    if (name.Trim().Length == 0) name = el.Cached.HelpText ?? "";
    bool password = el.Cached.IsPassword;
    var flags = new List<string>();
    string value = null;
    object v = Cached(el, ValuePattern.ValueProperty);
    if (!password && v is string && ((string)v).Length > 0 && (string)v != name) value = (string)v;
    object t = Cached(el, TogglePattern.ToggleStateProperty);
    if (t is ToggleState) flags.Add((ToggleState)t == ToggleState.On ? "ticked" : (ToggleState)t == ToggleState.Off ? "not ticked" : "part ticked");
    object s = Cached(el, SelectionItemPattern.IsSelectedProperty);
    if (s is bool && !(t is ToggleState)) {
      if (ct == ControlType.RadioButton) flags.Add((bool)s ? "ticked" : "not ticked");
      else if ((bool)s) flags.Add("selected");
    }
    object e = Cached(el, ExpandCollapsePattern.ExpandCollapseStateProperty);
    if (e is ExpandCollapseState && (ExpandCollapseState)e == ExpandCollapseState.Expanded && ct == ControlType.ComboBox) flags.Add("open");
    if (!el.Cached.IsEnabled) flags.Add("disabled");
    if (password) flags.Add("password");
    return new Dictionary<string, object> {
      { "n", n }, { "type", Friendly(ct) }, { "name", name.Trim() }, { "value", value }, { "flags", flags }
    };
  }

  /* --------------------------------------------------------------- hands */

  static AutomationElement Ref(int n) {
    if (refs.Count == 0) throw new Exception("No window has been read yet. Read the window first and use a number from that list.");
    if (n < 1 || n > refs.Count) throw new Exception("There is no [" + n + "] in the last read (it had " + refs.Count + "). Read the window again.");
    if (!IsWindow(refsWindow)) throw new Exception("The window that list came from has closed.");
    return refs[n - 1];
  }

  /** A pattern call, on its own thread: Invoke on a button that opens a modal dialog does not return until the dialog closes. */
  static bool Timed(Action act) {
    var task = Task.Run(act);
    if (task.Wait(3000)) return true;
    return false;
  }

  static string Label(AutomationElement el) {
    try {
      string name = el.Current.Name;
      string type = Friendly(el.Current.ControlType);
      return name != null && name.Trim().Length > 0 ? type + " \"" + Clip(name.Trim(), 60) + "\"" : type;
    } catch (Exception) { return "that control"; }
  }

  static string State(AutomationElement el) {
    try {
      object p;
      if (el.TryGetCurrentPattern(TogglePattern.Pattern, out p)) {
        var st = ((TogglePattern)p).Current.ToggleState;
        return st == ToggleState.On ? "It is ticked now." : st == ToggleState.Off ? "It is not ticked now." : "It is part ticked now.";
      }
      if (el.Current.ControlType == ControlType.RadioButton && el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p))
        return ((SelectionItemPattern)p).Current.IsSelected ? "It is ticked now." : "It is not ticked now.";
      if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p))
        return ((ExpandCollapsePattern)p).Current.ExpandCollapseState == ExpandCollapseState.Expanded ? "It is open now." : "";
      return "";
    } catch (ElementNotAvailableException) { return "That control is gone now, so the window changed."; } catch (Exception) { return ""; }
  }

  static IntPtr RootAt(int x, int y) {
    var pt = new POINT(); pt.X = x; pt.Y = y;
    var h = WindowFromPoint(pt);
    return h == IntPtr.Zero ? h : GetAncestor(h, GA_ROOT);
  }

  static bool MouseClick(int x, int y) {
    if (!SetCursorPos(x, y)) return false;
    Thread.Sleep(30);
    var inputs = new INPUT[2];
    inputs[0].type = INPUT_MOUSE; inputs[0].u.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    inputs[1].type = INPUT_MOUSE; inputs[1].u.mi.dwFlags = MOUSEEVENTF_LEFTUP;
    return SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) == 2;
  }

  /** A real click in the middle of an element, only when its window is what is under that point. */
  static string ClickCentre(AutomationElement el) {
    Rect r = el.Current.BoundingRectangle;
    if (r.IsEmpty) return "It has no place on the screen, so it was not clicked.";
    int x = (int)(r.X + r.Width / 2), y = (int)(r.Y + r.Height / 2);
    if (RootAt(x, y) != refsWindow) return "Something else is on top of it, so it was not clicked.";
    return MouseClick(x, y) ? "" : "Windows refused the mouse click (the window may be running as administrator).";
  }

  static object ClickRef(int n) {
    var el = Ref(n);
    string label = Label(el);
    bool focused = Focus(refsWindow);
    object p;
    string did;
    var ct = el.Current.ControlType;
    if (el.TryGetCurrentPattern(TogglePattern.Pattern, out p)) {
      var tp = (TogglePattern)p;
      did = Timed(() => tp.Toggle()) ? "Clicked " + label + "." : "Clicked " + label + "; the app is still busy (a dialog may have opened).";
    } else if (ct != ControlType.Button && el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) {
      var sp = (SelectionItemPattern)p;
      did = Timed(() => sp.Select()) ? "Selected " + label + "." : "Selected " + label + "; the app is still busy.";
    } else if (el.TryGetCurrentPattern(InvokePattern.Pattern, out p)) {
      var ip = (InvokePattern)p;
      did = Timed(() => ip.Invoke()) ? "Clicked " + label + "." : "Clicked " + label + "; the app is still busy (a dialog may have opened).";
    } else if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) {
      var ep = (ExpandCollapsePattern)p;
      bool open = ep.Current.ExpandCollapseState == ExpandCollapseState.Expanded;
      Timed(() => { if (open) ep.Collapse(); else ep.Expand(); });
      did = (open ? "Closed " : "Opened ") + label + ".";
    } else {
      if (!focused) return "Windows would not bring that window forward, so " + label + " was not clicked.";
      string problem = ClickCentre(el);
      if (problem.Length > 0) return label + ": " + problem;
      did = "Clicked " + label + " with the mouse.";
    }
    Thread.Sleep(400);
    string state = State(el);
    return state.Length > 0 ? did + " " + state : did;
  }

  static object ClickXY(int x, int y, HashSet<uint> own) {
    IntPtr root = RootAt(x, y);
    if (root == IntPtr.Zero) return "There is no window at that point, so nothing was clicked.";
    uint pid;
    GetWindowThreadProcessId(root, out pid);
    if (own.Contains(pid)) return "That point is on Forge's own window, so nothing was clicked.";
    string where = AppOf(pid) + " — " + TitleOf(root);
    if (!MouseClick(x, y)) return "Windows refused the mouse click on " + where + " (it may be running as administrator).";
    return "Clicked at screen point " + x + "," + y + " on " + where + ".";
  }

  static INPUT Key(ushort vk, bool up) {
    var i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wVk = vk;
    uint flags = up ? KEYEVENTF_KEYUP : 0;
    if ((vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E) flags |= KEYEVENTF_EXTENDEDKEY;
    i.u.ki.dwFlags = flags;
    return i;
  }

  static bool Send(List<INPUT> list) {
    if (list.Count == 0) return true;
    return SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT))) == list.Count;
  }

  static bool Chord(ushort vk, bool ctrl, bool shift, bool alt) {
    var list = new List<INPUT>();
    if (ctrl) list.Add(Key(VK_CONTROL, false));
    if (shift) list.Add(Key(VK_SHIFT, false));
    if (alt) list.Add(Key(VK_MENU, false));
    list.Add(Key(vk, false));
    list.Add(Key(vk, true));
    if (alt) list.Add(Key(VK_MENU, true));
    if (shift) list.Add(Key(VK_SHIFT, true));
    if (ctrl) list.Add(Key(VK_CONTROL, true));
    return Send(list);
  }

  /** Literal text as Unicode key events; a new line is Enter and a tab is Tab. */
  static bool SendText(string text) {
    var list = new List<INPUT>();
    foreach (char c in text) {
      if (c == '\r') continue;
      if (c == '\n' || c == '\t') { list.Add(Key(c == '\n' ? VK_RETURN : VK_TAB, false)); list.Add(Key(c == '\n' ? VK_RETURN : VK_TAB, true)); continue; }
      var down = new INPUT(); down.type = INPUT_KEYBOARD; down.u.ki.wScan = c; down.u.ki.dwFlags = KEYEVENTF_UNICODE;
      var up = down; up.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      list.Add(down); list.Add(up);
    }
    for (int i = 0; i < list.Count; i += 200) {
      if (!Send(list.GetRange(i, Math.Min(200, list.Count - i)))) return false;
      Thread.Sleep(10);
    }
    return true;
  }

  const string PasswordRefusal = "That is a password box. Ask Steve to type it himself.";

  static bool FocusedIsPassword() {
    try { var f = AutomationElement.FocusedElement; return f != null && f.Current.IsPassword; } catch (Exception) { return false; }
  }

  static object TypeText(int n, IntPtr h, string text, bool enter) {
    text = text ?? "";
    if (n > 0) {
      var el = Ref(n);
      h = refsWindow;
      if (el.Current.IsPassword) return PasswordRefusal;
      string label = Label(el);
      bool set = false;
      object p;
      if (text.Length > 0 && el.TryGetCurrentPattern(ValuePattern.Pattern, out p) && !((ValuePattern)p).Current.IsReadOnly) {
        var vp = (ValuePattern)p;
        Timed(() => vp.SetValue(text));
        Thread.Sleep(150);
        try { set = vp.Current.Value == text; } catch (Exception) { set = false; }
      }
      if (!set && text.Length > 0) {
        if (!Focus(h)) return "Windows would not bring that window forward, so nothing was typed.";
        try { el.SetFocus(); } catch (Exception) { string problem = ClickCentre(el); if (problem.Length > 0) return label + ": " + problem; }
        Thread.Sleep(100);
        if (FocusedIsPassword()) return PasswordRefusal;
        Chord(0x41, true, false, false);
        if (!SendText(text)) return "Windows refused the key presses (the window may be running as administrator).";
      }
      if (enter) {
        if (!Focus(h)) return (text.Length > 0 ? "Typed into " + label + ", but " : "") + "Windows would not bring that window forward, so Enter was not pressed.";
        try { el.SetFocus(); } catch (Exception) { }
        Chord(VK_RETURN, false, false, false);
      }
      Thread.Sleep(200);
      string now = "";
      try { object vp2; if (el.TryGetCurrentPattern(ValuePattern.Pattern, out vp2)) now = ((ValuePattern)vp2).Current.Value ?? ""; } catch (Exception) { }
      string said = text.Length > 0 ? "Typed into " + label + (now.Length > 0 ? "; it now says \"" + Clip(now, 120) + "\"" : "") + "." : "Did not type anything.";
      return enter ? said + " Pressed Enter." : said;
    }
    if (!Focus(h)) return "Windows would not bring that window forward, so nothing was typed.";
    Thread.Sleep(100);
    if (FocusedIsPassword()) return PasswordRefusal;
    if (text.Length > 0 && !SendText(text)) return "Windows refused the key presses (the window may be running as administrator).";
    if (enter) Chord(VK_RETURN, false, false, false);
    return "Typed into " + TitleOf(h) + " where its cursor was" + (enter ? ", then pressed Enter." : ".");
  }

  static object Keys(IntPtr h, IEnumerable keys) {
    if (keys == null) throw new Exception("No keys were given.");
    if (!Focus(h)) return "Windows would not bring " + TitleOf(h) + " forward, so no keys were pressed.";
    int pressed = 0;
    foreach (object k in keys) {
      var d = k as Dictionary<string, object>;
      if (d == null) continue;
      if (!Chord((ushort)Int(d, "vk", 0), Bool(d, "ctrl"), Bool(d, "shift"), Bool(d, "alt")))
        return "Windows refused the key presses after " + pressed + " (the window may be running as administrator).";
      pressed++;
      Thread.Sleep(60);
    }
    return "Pressed " + pressed + " key" + (pressed == 1 ? "" : "s") + " in " + TitleOf(h) + ".";
  }

  /* ------------------------------------------------------------- helpers */

  static string Friendly(ControlType ct) {
    if (ct == ControlType.Edit) return "text box";
    if (ct == ControlType.CheckBox) return "tick box";
    if (ct == ControlType.RadioButton) return "radio";
    if (ct == ControlType.ComboBox) return "drop-down";
    if (ct == ControlType.Hyperlink) return "link";
    if (ct == ControlType.ListItem) return "list item";
    if (ct == ControlType.MenuItem) return "menu item";
    if (ct == ControlType.TabItem) return "tab";
    if (ct == ControlType.Button) return "button";
    return ct.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant();
  }

  static string Clip(string s, int n) { return s.Length <= n ? s : s.Substring(0, n) + "…"; }
  static string Str(Dictionary<string, object> a, string k) { object v; return a.TryGetValue(k, out v) && v != null ? v.ToString() : ""; }
  static int Int(Dictionary<string, object> a, string k, int dflt) { object v; return a.TryGetValue(k, out v) && v != null ? Convert.ToInt32(v) : dflt; }
  static bool Bool(Dictionary<string, object> a, string k) { object v; return a.TryGetValue(k, out v) && v is bool && (bool)v; }
  static IntPtr Handle(Dictionary<string, object> a) { object v; return a.TryGetValue("hwnd", out v) && v != null ? new IntPtr(Convert.ToInt64(v)) : IntPtr.Zero; }
  static HashSet<uint> Pids(Dictionary<string, object> a) {
    var set = new HashSet<uint>();
    object v;
    if (a.TryGetValue("own", out v) && v is IEnumerable) foreach (object p in (IEnumerable)v) set.Add(Convert.ToUInt32(p));
    return set;
  }
}
`
