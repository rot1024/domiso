# WASAPI loopback capture for `pnpm cli record` on Windows: records what an output device plays (like
# Audacity's "loopback" devices), with no virtual cable or Stereo Mix needed.
#
#   -List           prints the active output devices, the default one first
#   -Device <text>  records the output device whose name contains <text> (default: the default device)
#
# While recording, writes "FORMAT <rate> <channels>" to stderr, then streams interleaved float32 samples to
# stdout until "q" (or end of input) arrives on stdin. Loopback delivers nothing while the device is
# idle, so packets are placed by their timestamps and long idle stretches are filled with silence, keeping
# the stream in real time.
param([switch]$List, [string]$Device = "")

$ErrorActionPreference = "Stop"
# Device names go to stdout/stderr as UTF-8, whatever the console code page is.
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace DomisoLoopback {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }

  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    int GetCount(out int count);
    int Item(int index, out IMMDevice device);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    int OpenPropertyStore(int access, out IPropertyStore store);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  }

  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    int GetCount(out int count);
    int GetAt(int index, out PropertyKey key);
    int GetValue(ref PropertyKey key, out PropVariant value);
  }

  [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid fmtid; public int pid; }

  [StructLayout(LayoutKind.Explicit, Size = 24)] struct PropVariant {
    [FieldOffset(0)] public short vt;
    [FieldOffset(8)] public IntPtr pointer;
  }

  [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioClient {
    int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
    int GetBufferSize(out uint frames);
    int GetStreamLatency(out long latency);
    int GetCurrentPadding(out uint padding);
    int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    int GetMixFormat(out IntPtr format);
    int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    int Start();
    int Stop();
    int Reset();
    int SetEventHandle(IntPtr handle);
    int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
  }

  [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioCaptureClient {
    int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    int ReleaseBuffer(uint frames);
    int GetNextPacketSize(out uint frames);
  }

  public static class Capture {
    const int eRender = 0, eConsole = 0, DEVICE_STATE_ACTIVE = 1, CLSCTX_ALL = 23;
    const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000, AUDCLNT_BUFFERFLAGS_SILENT = 2;
    static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
    static readonly Guid FLOAT_SUBTYPE = new Guid("00000003-0000-0010-8000-00aa00389b71");

    static void Check(int hr, string what) {
      if (hr < 0) throw new Exception(what + " failed: 0x" + hr.ToString("X8"));
    }

    static string Name(IMMDevice device) {
      IPropertyStore store;
      Check(device.OpenPropertyStore(0, out store), "OpenPropertyStore");
      PropertyKey key = new PropertyKey();
      key.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"); // PKEY_Device_FriendlyName
      key.pid = 14;
      PropVariant value;
      Check(store.GetValue(ref key, out value), "GetValue");
      return value.vt == 31 ? Marshal.PtrToStringUni(value.pointer) : "";
    }

    static IMMDeviceEnumerator Enumerator() {
      return (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
    }

    /// Active output devices, the default one first.
    public static List<string> List() {
      IMMDeviceEnumerator e = Enumerator();
      List<string> names = new List<string>();
      IMMDevice def;
      string defaultName = "";
      if (e.GetDefaultAudioEndpoint(eRender, eConsole, out def) >= 0) {
        defaultName = Name(def);
        names.Add(defaultName);
      }
      IMMDeviceCollection all;
      Check(e.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out all), "EnumAudioEndpoints");
      int count;
      all.GetCount(out count);
      for (int i = 0; i < count; i++) {
        IMMDevice d;
        all.Item(i, out d);
        string n = Name(d);
        if (n != defaultName) names.Add(n);
      }
      return names;
    }

    static IMMDevice Find(string match) {
      IMMDeviceEnumerator e = Enumerator();
      IMMDevice device;
      if (match == "") {
        Check(e.GetDefaultAudioEndpoint(eRender, eConsole, out device), "GetDefaultAudioEndpoint");
        return device;
      }
      IMMDeviceCollection all;
      Check(e.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out all), "EnumAudioEndpoints");
      int count;
      all.GetCount(out count);
      for (int i = 0; i < count; i++) {
        all.Item(i, out device);
        if (Name(device).IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0) return device;
      }
      throw new Exception("no output device matches: " + match);
    }

    static long Now() {
      return (long)(Stopwatch.GetTimestamp() * (10000000.0 / Stopwatch.Frequency));
    }

    static long WriteSilence(Stream stdout, long frames, int frameBytes, ref byte[] buf) {
      int bytes = (int)frames * frameBytes;
      if (buf.Length < bytes) buf = new byte[bytes];
      Array.Clear(buf, 0, bytes);
      stdout.Write(buf, 0, bytes);
      return frames;
    }

    public static void Run(string match) {
      IMMDevice device = Find(match);
      Guid iid = IID_IAudioClient;
      object o;
      Check(device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o), "Activate");
      IAudioClient client = (IAudioClient)o;

      IntPtr format;
      Check(client.GetMixFormat(out format), "GetMixFormat");
      int tag = Marshal.ReadInt16(format, 0);
      int channels = Marshal.ReadInt16(format, 2);
      int rate = Marshal.ReadInt32(format, 4);
      int blockAlign = Marshal.ReadInt16(format, 12);
      int bits = Marshal.ReadInt16(format, 14);
      bool isFloat = tag == 3;
      if (tag == unchecked((short)0xFFFE)) {
        byte[] sub = new byte[16];
        Marshal.Copy(new IntPtr(format.ToInt64() + 24), sub, 0, 16);
        isFloat = new Guid(sub) == FLOAT_SUBTYPE;
      }

      Check(client.Initialize(0, AUDCLNT_STREAMFLAGS_LOOPBACK, 10000000, 0, format, IntPtr.Zero), "Initialize");
      Guid ciid = IID_IAudioCaptureClient;
      object co;
      Check(client.GetService(ref ciid, out co), "GetService");
      IAudioCaptureClient capture = (IAudioCaptureClient)co;

      Stream stdout = Console.OpenStandardOutput();
      Console.Error.WriteLine("FORMAT " + rate + " " + channels + " " + Name(device));
      Console.Error.Flush();

      bool stop = false;
      Thread input = new Thread(delegate () {
        Stream stdin = Console.OpenStandardInput();
        byte[] b = new byte[1];
        while (true) {
          int n;
          try { n = stdin.Read(b, 0, 1); } catch { n = 0; }
          if (n <= 0 || b[0] == (byte)'q') { stop = true; return; }
        }
      });
      input.IsBackground = true;
      input.Start();

      Check(client.Start(), "Start");
      // Packet timestamps are in 100 ns units on the QPC clock, the same clock Stopwatch reads.
      long startHns = Now();
      long lastPacketHns = startHns;
      long written = 0;
      int outFrameBytes = channels * 4;
      byte[] raw = new byte[0];
      byte[] outBuf = new byte[0];
      try {
        while (!stop) {
          Thread.Sleep(10);
          uint packet;
          Check(capture.GetNextPacketSize(out packet), "GetNextPacketSize");
          while (packet > 0) {
            IntPtr data;
            uint frames, flags;
            ulong devPos, qpc;
            Check(capture.GetBuffer(out data, out frames, out flags, out devPos, out qpc), "GetBuffer");
            lastPacketHns = Now();
            // A gap before this packet (the device was idle): pad it so the packet lands at its time.
            long at = ((long)qpc - startHns) * rate / 10000000;
            if (at - written > rate / 50) written += WriteSilence(stdout, at - written, outFrameBytes, ref outBuf);
            int outBytes = (int)frames * outFrameBytes;
            if (outBuf.Length < outBytes) outBuf = new byte[outBytes];
            if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) {
              Array.Clear(outBuf, 0, outBytes);
            } else if (isFloat && bits == 32) {
              Marshal.Copy(data, outBuf, 0, outBytes);
            } else {
              // Integer PCM: convert to float32.
              int inBytes = (int)frames * blockAlign;
              if (raw.Length < inBytes) raw = new byte[inBytes];
              Marshal.Copy(data, raw, 0, inBytes);
              int bytesPer = bits / 8;
              for (int s = 0; s < frames * channels; s++) {
                float v;
                if (bits == 16) v = BitConverter.ToInt16(raw, s * 2) / 32768f;
                else if (bits == 24) v = ((raw[s * 3] << 8 | raw[s * 3 + 1] << 16 | raw[s * 3 + 2] << 24) >> 8) / 8388608f;
                else v = BitConverter.ToInt32(raw, s * bytesPer) / 2147483648f;
                Buffer.BlockCopy(BitConverter.GetBytes(v), 0, outBuf, s * 4, 4);
              }
            }
            stdout.Write(outBuf, 0, outBytes);
            written += frames;
            Check(capture.ReleaseBuffer(frames), "ReleaseBuffer");
            Check(capture.GetNextPacketSize(out packet), "GetNextPacketSize");
          }
          // Nothing is delivered while the device is idle. Once that has lasted a while, write silence up to
          // shortly before now, so a listener sees time pass (a short margin avoids overlapping late packets).
          long now = Now();
          if (now - lastPacketHns > 2000000) {
            long expected = (now - startHns) * rate / 10000000 - rate / 10;
            if (expected > written) written += WriteSilence(stdout, expected - written, outFrameBytes, ref outBuf);
          }
          stdout.Flush();
        }
      } catch (IOException) {
        // The reader went away; nothing more to do.
      } finally {
        client.Stop();
      }
    }
  }
}
"@

if ($List) {
  foreach ($name in [DomisoLoopback.Capture]::List()) { [Console]::Out.WriteLine($name) }
} else {
  [DomisoLoopback.Capture]::Run($Device)
}
