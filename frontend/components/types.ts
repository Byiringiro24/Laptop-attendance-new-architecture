// Shared types for the tablet frontend

export type NavView = "dashboard" | "students" | "gate" | "attendance" | "users";

export type Stats = {
  totalStudents: number;
  totalDevices: number;
  onlineDevices: number;
  attendanceToday: number;
  lateStudents: number;
  totalLogs: number;
};

export type PerDeviceStat = {
  id: string;
  name: string;
  ipAddress: string;
  location: string;
  connected: boolean;
  studentCount: number;
};

export type DeviceStatus = {
  connected?: boolean;
  deviceId?: string;
  ipAddress?: string;
  port?: number;
  handle?: number;
  serialNumber?: string;
  productName?: string;
  productCode?: string;
  users?: number;
  logs?: number;
  faces?: number;
  fingerprints?: number;
  cards?: number;
};

export type AttendanceLog = {
  id: string;
  studentId?: string;
  studentDeviceId?: string;
  studentName: string;
  className?: string;
  section?: string;
  deviceId: string;
  authenticationMethod: string;
  timestamp: string;
  status: string;
  direction?: string;
  photoUrl?: string;
  studentType?: string;
  boardingStatus?: string;
  roomName?: string;
  dormitoryName?: string;
  deviceUserId?: string;
  rawData?: Record<string, any>;
};

export type Student = {
  studentId: string;
  studentDeviceId: string;
  name: string;
  className: string;
  section?: string;
  assignedDeviceId?: string;
  registeredOnDevice?: string;
  registeredOnDeviceName?: string;
  createdAt?: string;
  updatedAt?: string;
  parentPhone?: string;
  biometricMethods?: string[];
  deviceUser?: DeviceUser;
};

export type DeviceUser = {
  userId: string;
  studentDeviceId: string;
  name: string;
  privilege: number;
  enabled: boolean;
  biometricMethods: string[];
  fingerprintRegistered?: boolean;
  faceRegistered?: boolean;
  cardRegistered?: boolean;
  student?: Student | null;
};

export type ApprovedExit = {
  id: string;
  leave_id?: string;
  student_id?: string;
  leave_type: string;
  leave_category: string;
  leave_state: string;
  start_date: string;
  end_date: string;
  start_time?: string | null;
  expected_return_time?: string | null;
  exited_at?: string | null;
  returned_at?: string | null;
  late_return_flagged?: boolean;
  reason?: string | null;
  destination?: string | null;
  student?: {
    id: string;
    student_id?: string | null;
    first_name: string;
    last_name: string;
    student_id_number?: string | null;
    photo_url?: string | null;
    boarding_status?: string | null;
  } | null;
};

export type SchoolUser = {
  id: string;
  name: string;
  email?: string | null;
  role: string;
  status?: string;
};
