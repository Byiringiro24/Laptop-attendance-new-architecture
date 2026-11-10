using System.Globalization;
using System.Runtime.InteropServices;
using Newtonsoft.Json;

namespace FKBridge;

public class FKDevice
{
    [DllImport("FK623Attend.dll", CharSet = CharSet.Ansi)]
    public static extern int FK_ConnectNet(int anMachineNo, string astrIpAddress, int anNetPort, int anTimeOut, int anProtocolType, int anNetPassword, int anLicense);

    [DllImport("FK623Attend.dll", CharSet = CharSet.Ansi)]
    public static extern void FK_DisConnect(int anHandleIndex);

    [DllImport("FK623Attend.dll", CharSet = CharSet.Ansi)]
    public static extern int FK_EnableDevice(int anHandleIndex, byte anEnableFlag);

    [DllImport("FK623Attend.dll", CharSet = CharSet.Ansi)]
    public static extern int FK_SetDeviceTime(int anHandleIndex, DateTime anDateTime);

    [DllImport("FK623Attend.dll", CharSet = CharSet.Ansi)]
    public static extern int FK_GetDeviceStatus(int anHandleIndex, int anStatusIndex, ref int apnValue);

    [DllImport("FK623Attend.dll", CharSet = CharSet.Ansi)]
    public static extern int FK_GetProductData(int anHandleIndex, int anDataIndex, [MarshalAs(UnmanagedType.LPStr)] ref string apstrValue);

    [DllImport("FK623Attend.dll", CharSet = CharSet.Ansi)]
    public static extern int FK_ReadAllUserID(int anHandleIndex);

    [DllImport("FK623Attend.dll", CharSet = CharSet.Ansi)]
    public static extern int FK_GetAllUserID(int anHandleIndex, ref UInt32 apnEnrollNumber, ref int apnBackupNumber, ref int apnMachinePrivilege, ref int apnEnable);

    [DllImport("FK623Attend.dll", CharSet = CharSet.Ansi)]
    public static extern int FK_GetAllUserID_StringID(int anHandleIndex, ref string apEnrollNumber, ref int apnBackupNumber, ref int apnMachinePrivilege, ref int apnEnableFlag);

    [DllImport("FK623Attend.dll", CharSet = CharSet.Ansi)]
    public static extern int FK_GetUserName_StringID(int anHandleIndex, string apEnrollNumber, [MarshalAs(UnmanagedType.LPStr)] ref string apstrUserName);

    [DllImport("FK623Attend.dll", CharSet = CharSet.Ansi)]
    public static extern int FK_GetUserName(int anHandleIndex, UInt32 anEnrollNumber, [MarshalAs(UnmanagedType.LPStr)] ref string apstrUserName);

    [DllImport("FK623Attend.dll", CharSet = CharSet.Ansi)]
    public static extern int FK_SetUserName_StringID(int anHandleIndex, string apEnrollNumber, string astrUserName);

    [DllImport("FK623Attend.dll", CharSet = CharSet.Ansi)]
    public static extern int FK_SetUserName(int anHandleIndex, UInt32 anEnrollNumber, string astrUserName);

    [DllImport("FK623Attend.dll", CharSet = CharSet.Ansi)]
    public static extern int FK_DeleteEnrollData_StringID(int anHandleIndex, string apEnrollNumber, int anBackupNumber);

    [DllImport("FK623Attend.dll", CharSet = CharSet.Ansi)]
    public static extern int FK_LoadGeneralLogData(int anHandleIndex, int anReadMark);

    [DllImport("FK623Attend.dll", CharSet = CharSet.Ansi)]
    public static extern int FK_GetGeneralLogData_StringID_Workcode(int anHandleIndex, [MarshalAs(UnmanagedType.LPStr)] ref string apnEnrollNumber, ref int apnVerifyMode, ref int apnInOutMode, ref DateTime apnDateTime, ref int apnWorkCode);

    [DllImport("FK623Attend.dll", CharSet = CharSet.Ansi)]
    public static extern int FK_GetGeneralLogData(int anHandleIndex, ref UInt32 apnEnrollNumber, ref int apnVerifyMode, ref int apnInOutMode, ref DateTime apnDateTime);

    [DllImport("FK623Attend.dll", CharSet = CharSet.Ansi)]
    public static extern int FK_EmptyGeneralLogData(int anHandleIndex);

    [DllImport("FK623Attend.dll", CharSet = CharSet.Ansi)]
    public static extern int FK_ClearKeeperData(int anHandleIndex);

    [DllImport("FK623Attend.dll", CharSet = CharSet.Ansi)]
    public static extern int FK_PowerOffDevice(int anHandleIndex);
}

public record BridgeResult(bool success, string type, object? data = null, string? error = null, int? code = null);

public class Program
{
    private const int RunSuccess = 1;
    private const int DataArrayEnd = -7;
    private static int deviceHandle = -1;
    private static bool connected;
    private static string currentIp = "";
    private static int currentPort;
    private static int currentProtocolType = -1;
    private static string deviceId = "";

    public static void Main()
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Write(new BridgeResult(true, "READY", new { pid = Environment.ProcessId }));

        string? command;
        while ((command = Console.ReadLine()) != null)
        {
            if (string.IsNullOrWhiteSpace(command)) continue;
            try
            {
                Handle(command.Trim());
            }
            catch (Exception ex)
            {
                Write(new BridgeResult(false, "ERROR", error: ex.Message));
            }
        }
    }

    private static void Handle(string command)
    {
        var parts = command.Split('|');
        var action = parts[0].ToUpperInvariant();

        switch (action)
        {
            case "CONNECT":
                Connect(
                    parts.ElementAtOrDefault(1) ?? "",
                    ParseInt(parts.ElementAtOrDefault(2), 5005),
                    ParseInt(parts.ElementAtOrDefault(3), 1261),
                    parts.ElementAtOrDefault(4) ?? "",
                    ParseInt(parts.ElementAtOrDefault(5), 0),
                    ParseInt(parts.ElementAtOrDefault(6), -1),
                    ParseInt(parts.ElementAtOrDefault(7), 5000)
                );
                break;
            case "DISCONNECT":
                Disconnect();
                Write(new BridgeResult(true, "DISCONNECTED"));
                break;
            case "STATUS":
                Write(new BridgeResult(true, "STATUS", BuildStatus()));
                break;
            case "GET_USERS":
                GetUsers();
                break;
            case "GET_LOGS":
                GetLogs(ParseInt(parts.ElementAtOrDefault(1), 0));
                break;
            case "SYNC_TIME":
                SyncTime();
                break;
            case "SET_TIME":
                SetTime(parts.ElementAtOrDefault(1));
                break;
            case "ADD_USER":
                AddUser(parts.ElementAtOrDefault(1) ?? "", parts.ElementAtOrDefault(2) ?? "");
                break;
            case "DELETE_USER":
                DeleteUser(parts.ElementAtOrDefault(1) ?? "");
                break;
            case "CLEAR_LOGS":
                ClearLogs();
                break;
            case "CLEAR_ALL":
                ClearAll();
                break;
            case "POWEROFF":
                PowerOff();
                break;
            case "EXIT":
                Disconnect();
                Write(new BridgeResult(true, "EXIT"));
                Environment.Exit(0);
                break;
            default:
                Write(new BridgeResult(false, action, error: $"Unknown command: {action}"));
                break;
        }
    }

    private static void Connect(string ip, int port, int license, string requestedDeviceId, int netPassword, int protocolType, int timeoutMs)
    {
        if (connected) Disconnect();
        if (string.IsNullOrWhiteSpace(ip))
        {
            Write(new BridgeResult(false, "CONNECTED", error: "IP address is required"));
            return;
        }

        var connectTimeout = Math.Clamp(timeoutMs, 1000, 30000);
        var protocols = protocolType >= 0 ? new[] { protocolType } : new[] { 0, 1 };
        var attempts = new List<(int Protocol, int Code)>();

        foreach (var protocol in protocols)
        {
            var result = FKDevice.FK_ConnectNet(1, ip, port, connectTimeout, protocol, netPassword, license);
            if (result > 0)
            {
                deviceHandle = result;
                connected = true;
                currentIp = ip;
                currentPort = port;
                currentProtocolType = protocol;
                deviceId = requestedDeviceId;
                FKDevice.FK_EnableDevice(deviceHandle, 1);
                Write(new BridgeResult(true, "CONNECTED", BuildStatus()));
                return;
            }
            attempts.Add((protocol, result));
        }

        var error = attempts.Count == 1
            ? ConnectionError(attempts[0].Code)
            : string.Join(" | ", attempts.Select((item) => $"protocol {item.Protocol}: {ConnectionError(item.Code)}"));
        var lastCode = attempts.LastOrDefault().Code;
        Write(new BridgeResult(false, "CONNECTED", error: error, code: lastCode));
    }

    private static void Disconnect()
    {
        if (connected && deviceHandle > 0)
        {
            try
            {
                FKDevice.FK_EnableDevice(deviceHandle, 1);
                FKDevice.FK_DisConnect(deviceHandle);
            }
            catch { }
        }
        connected = false;
        deviceHandle = -1;
        currentProtocolType = -1;
    }

    private static void GetUsers()
    {
        if (!EnsureConnected("USERS")) return;
        var users = new List<object>();

        FKDevice.FK_EnableDevice(deviceHandle, 0);
        var readResult = FKDevice.FK_ReadAllUserID(deviceHandle);
        if (readResult != RunSuccess)
        {
            FKDevice.FK_EnableDevice(deviceHandle, 1);
            Write(new BridgeResult(false, "USERS", error: $"FK_ReadAllUserID failed: {readResult}", code: readResult));
            return;
        }

        var firstStringResult = ReadStringUsers(users);
        if (users.Count == 0 && firstStringResult != DataArrayEnd)
        {
            FKDevice.FK_ReadAllUserID(deviceHandle);
            var numericResult = ReadNumericUsers(users);
            if (numericResult != DataArrayEnd && numericResult != RunSuccess)
            {
                FKDevice.FK_EnableDevice(deviceHandle, 1);
                Write(new BridgeResult(false, "USERS", error: $"User read failed. StringID={firstStringResult}, NumericID={numericResult}", code: numericResult));
                return;
            }
        }

        FKDevice.FK_EnableDevice(deviceHandle, 1);
        Write(new BridgeResult(true, "USERS", new { users, count = users.Count }));
    }

    private static int ReadStringUsers(List<object> users)
    {
        while (true)
        {
            string enrollNumber = new(' ', 32);
            int backup = 0;
            int privilege = 0;
            int enabled = 0;
            var result = FKDevice.FK_GetAllUserID_StringID(deviceHandle, ref enrollNumber, ref backup, ref privilege, ref enabled);
            if (result == DataArrayEnd) return result;
            if (result != RunSuccess) return result;

            var userId = Clean(enrollNumber);
            if (string.IsNullOrWhiteSpace(userId)) continue;
            string name = new(' ', 256);
            FKDevice.FK_GetUserName_StringID(deviceHandle, userId, ref name);
            users.Add(new { userId, name = Clean(name), backupNumber = backup, privilege, enabled = enabled == 1 });
        }
    }

    private static int ReadNumericUsers(List<object> users)
    {
        while (true)
        {
            UInt32 enrollNumber = 0;
            int backup = 0;
            int privilege = 0;
            int enabled = 0;
            var result = FKDevice.FK_GetAllUserID(deviceHandle, ref enrollNumber, ref backup, ref privilege, ref enabled);
            if (result == DataArrayEnd) return result;
            if (result != RunSuccess) return result;
            if (enrollNumber == 0) continue;

            string name = new(' ', 256);
            FKDevice.FK_GetUserName(deviceHandle, enrollNumber, ref name);
            users.Add(new { userId = enrollNumber.ToString(), name = Clean(name), backupNumber = backup, privilege, enabled = enabled == 1 });
        }
    }

    private static void GetLogs(int readMark)
    {
        if (!EnsureConnected("LOGS")) return;
        var logs = new List<object>();

        FKDevice.FK_EnableDevice(deviceHandle, 0);
        var loadResult = FKDevice.FK_LoadGeneralLogData(deviceHandle, readMark);
        if (loadResult != RunSuccess)
        {
            FKDevice.FK_EnableDevice(deviceHandle, 1);
            Write(new BridgeResult(false, "LOGS", error: $"FK_LoadGeneralLogData failed: {loadResult}", code: loadResult));
            return;
        }

        var firstStringResult = ReadStringLogs(logs);
        if (logs.Count == 0)
        {
            FKDevice.FK_LoadGeneralLogData(deviceHandle, readMark);
            var numericResult = ReadNumericLogs(logs);
            if (numericResult != DataArrayEnd && numericResult != RunSuccess)
            {
                FKDevice.FK_EnableDevice(deviceHandle, 1);
                Write(new BridgeResult(false, "LOGS", error: $"Log read failed. StringID={firstStringResult}, NumericID={numericResult}", code: numericResult));
                return;
            }
        }

        FKDevice.FK_EnableDevice(deviceHandle, 1);
        Write(new BridgeResult(true, "LOGS", new { logs, count = logs.Count }));
    }

    private static int ReadStringLogs(List<object> logs)
    {
        while (true)
        {
            string enrollNumber = new(' ', 32);
            int verifyMode = 0;
            int inOutMode = 0;
            int workCode = 0;
            DateTime timestamp = DateTime.MinValue;
            var result = FKDevice.FK_GetGeneralLogData_StringID_Workcode(deviceHandle, ref enrollNumber, ref verifyMode, ref inOutMode, ref timestamp, ref workCode);
            if (result == DataArrayEnd) return result;
            if (result != RunSuccess) return result;

            AddLog(logs, Clean(enrollNumber), timestamp, verifyMode, inOutMode, workCode);
        }
    }

    private static int ReadNumericLogs(List<object> logs)
    {
        while (true)
        {
            UInt32 enrollNumber = 0;
            int verifyMode = 0;
            int inOutMode = 0;
            DateTime timestamp = DateTime.MinValue;
            var result = FKDevice.FK_GetGeneralLogData(deviceHandle, ref enrollNumber, ref verifyMode, ref inOutMode, ref timestamp);
            if (result == DataArrayEnd) return result;
            if (result != RunSuccess) return result;
            AddLog(logs, enrollNumber.ToString(), timestamp, verifyMode, inOutMode, 0);
        }
    }

    private static void AddLog(List<object> logs, string userId, DateTime timestamp, int verifyMode, int inOutMode, int workCode)
    {
        if (string.IsNullOrWhiteSpace(userId)) return;
        logs.Add(new
        {
            id = $"{userId}-{timestamp:yyyyMMddHHmmss}-{logs.Count}",
            userId,
            timestamp = timestamp.ToString("o"),
            verifyMode,
            method = VerifyModeName(verifyMode),
            inOutMode,
            direction = DirectionName(inOutMode),
            workCode
        });
    }

    private static void SyncTime()
    {
        if (!EnsureConnected("SYNC_TIME")) return;
        FKDevice.FK_EnableDevice(deviceHandle, 0);
        var result = FKDevice.FK_SetDeviceTime(deviceHandle, DateTime.Now);
        FKDevice.FK_EnableDevice(deviceHandle, 1);
        Write(result == RunSuccess
            ? new BridgeResult(true, "SYNC_TIME", new { syncedAt = DateTime.Now.ToString("o") })
            : new BridgeResult(false, "SYNC_TIME", error: $"FK_SetDeviceTime failed: {result}", code: result));
    }

    private static void SetTime(string? timestamp)
    {
        if (!EnsureConnected("SET_TIME")) return;
        if (string.IsNullOrWhiteSpace(timestamp))
        {
            Write(new BridgeResult(false, "SET_TIME", error: "Timestamp is required"));
            return;
        }

        DateTime parsed;
        var exact = DateTime.TryParseExact(
            timestamp,
            "yyyy-MM-ddTHH:mm",
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeLocal,
            out parsed
        );

        if (!exact && !DateTime.TryParse(timestamp, CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out parsed)
            && !DateTime.TryParse(timestamp, out parsed))
        {
            Write(new BridgeResult(false, "SET_TIME", error: "Invalid timestamp format"));
            return;
        }

        FKDevice.FK_EnableDevice(deviceHandle, 0);
        var result = FKDevice.FK_SetDeviceTime(deviceHandle, parsed);
        FKDevice.FK_EnableDevice(deviceHandle, 1);
        Write(result == RunSuccess
            ? new BridgeResult(true, "SET_TIME", new { setAt = parsed.ToString("o") })
            : new BridgeResult(false, "SET_TIME", error: $"FK_SetDeviceTime failed: {result}", code: result));
    }

    private static void AddUser(string userId, string name)
    {
        if (!EnsureConnected("ADD_USER")) return;
        if (string.IsNullOrWhiteSpace(userId))
        {
            Write(new BridgeResult(false, "ADD_USER", error: "User ID is required"));
            return;
        }
        FKDevice.FK_EnableDevice(deviceHandle, 0);
        var result = FKDevice.FK_SetUserName_StringID(deviceHandle, userId, name);
        if (result != RunSuccess && UInt32.TryParse(userId, out var numericUserId))
        {
            result = FKDevice.FK_SetUserName(deviceHandle, numericUserId, name);
        }
        FKDevice.FK_EnableDevice(deviceHandle, 1);
        Write(result == RunSuccess
            ? new BridgeResult(true, "ADD_USER", new { userId, name })
            : new BridgeResult(false, "ADD_USER", error: $"Set user name failed: {result}", code: result));
    }

    private static void DeleteUser(string userId)
    {
        if (!EnsureConnected("DELETE_USER")) return;
        if (string.IsNullOrWhiteSpace(userId))
        {
            Write(new BridgeResult(false, "DELETE_USER", error: "User ID is required"));
            return;
        }
        FKDevice.FK_EnableDevice(deviceHandle, 0);
        for (var backup = 0; backup <= 12; backup++) FKDevice.FK_DeleteEnrollData_StringID(deviceHandle, userId, backup);
        FKDevice.FK_SetUserName_StringID(deviceHandle, userId, "");
        FKDevice.FK_EnableDevice(deviceHandle, 1);
        Write(new BridgeResult(true, "DELETE_USER", new { userId }));
    }

    private static void ClearLogs()
    {
        if (!EnsureConnected("CLEAR_LOGS")) return;
        FKDevice.FK_EnableDevice(deviceHandle, 0);
        var result = FKDevice.FK_EmptyGeneralLogData(deviceHandle);
        FKDevice.FK_EnableDevice(deviceHandle, 1);
        Write(result == RunSuccess ? new BridgeResult(true, "CLEAR_LOGS") : new BridgeResult(false, "CLEAR_LOGS", error: $"FK_EmptyGeneralLogData failed: {result}", code: result));
    }

    private static void ClearAll()
    {
        if (!EnsureConnected("CLEAR_ALL")) return;
        FKDevice.FK_EnableDevice(deviceHandle, 0);
        var result = FKDevice.FK_ClearKeeperData(deviceHandle);
        FKDevice.FK_EnableDevice(deviceHandle, 1);
        Write(result == RunSuccess ? new BridgeResult(true, "CLEAR_ALL") : new BridgeResult(false, "CLEAR_ALL", error: $"FK_ClearKeeperData failed: {result}", code: result));
    }

    private static void PowerOff()
    {
        if (!EnsureConnected("POWEROFF")) return;
        var result = FKDevice.FK_PowerOffDevice(deviceHandle);
        Write(result == RunSuccess ? new BridgeResult(true, "POWEROFF") : new BridgeResult(false, "POWEROFF", error: $"FK_PowerOffDevice failed: {result}", code: result));
    }

    private static bool EnsureConnected(string type)
    {
        if (connected && deviceHandle > 0) return true;
        Write(new BridgeResult(false, type, error: "Device not connected"));
        return false;
    }

    private static object BuildStatus()
    {
        var status = new Dictionary<string, object?>
        {
            ["connected"] = connected,
            ["handle"] = deviceHandle,
            ["ipAddress"] = currentIp,
            ["port"] = currentPort,
            ["protocolType"] = currentProtocolType,
            ["deviceId"] = deviceId
        };

        if (connected && deviceHandle > 0)
        {
            status["users"] = GetStatusValue(2);
            status["fingerprints"] = GetStatusValue(3);
            status["passwords"] = GetStatusValue(4);
            status["logs"] = GetStatusValue(6);
            status["cards"] = GetStatusValue(9);
            status["faces"] = GetStatusValue(10);
            status["serialNumber"] = GetProductValue(1);
            status["productCode"] = GetProductValue(3);
            status["productName"] = GetProductValue(4);
        }

        return status;
    }

    private static int? GetStatusValue(int index)
    {
        int value = 0;
        return FKDevice.FK_GetDeviceStatus(deviceHandle, index, ref value) == RunSuccess ? value : null;
    }

    private static string? GetProductValue(int index)
    {
        string value = new(' ', 256);
        return FKDevice.FK_GetProductData(deviceHandle, index, ref value) == RunSuccess ? Clean(value) : null;
    }

    private static string VerifyModeName(int mode) => mode switch
    {
        1 => "FINGERPRINT",
        2 => "PASSWORD",
        3 => "CARD",
        20 => "FACE",
        21 => "FACE_CARD",
        22 => "FACE_PASSWORD",
        23 => "CARD_FACE",
        24 => "PASSWORD_FACE",
        25 => "FACE_FINGERPRINT",
        26 => "FINGERPRINT_FACE",
        _ => $"MODE_{mode}"
    };

    private static string DirectionName(int inOutMode)
    {
        var low = inOutMode & 0x0f;
        var high = inOutMode >> 4;
        if (high == 1) return "IN";
        if (high == 2) return "OUT";
        return low switch { 1 or 3 or 5 or 7 => "IN", 2 or 4 or 6 or 8 => "OUT", _ => "UNKNOWN" };
    }

    private static int ParseInt(string? value, int fallback) => int.TryParse(value, out var parsed) ? parsed : fallback;

    private static string Clean(string value) => value.Replace("\0", "").Trim();

    private static string ConnectionError(int code) => code switch
    {
        -2 => "Device not reachable. Check the IP address, port, network, and that the device is powered on.",
        -3 => "Communication write failed.",
        -4 => "Communication read failed.",
        -5 => "Invalid parameter sent to the DLL.",
        -10 => "Invalid FK license key or network password.",
        _ => $"Connection failed with FK error code {code}."
    };

    private static void Write(BridgeResult result)
    {
        Console.WriteLine(JsonConvert.SerializeObject(result));
        Console.Out.Flush();
    }
}
