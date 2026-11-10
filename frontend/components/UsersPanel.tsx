"use client";
import { useEffect, useState, type FormEvent } from "react";
import toast from "react-hot-toast";
import { FiUserCheck, FiX, FiSettings, FiRefreshCw, FiPlus, FiTrash2 } from "react-icons/fi";
import { schoolApi } from "@/lib/api";

const ROLE_OPTIONS: Record<string, Array<{ value: string; label: string }>> = {
  school_admin: [
    { value: "teacher",                label: "Teacher" },
    { value: "staff",                  label: "Staff" },
    { value: "gate_keeper",            label: "Gate Keeper" },
    { value: "patron",                 label: "Patron" },
    { value: "matron",                 label: "Matron" },
    { value: "director_of_discipline", label: "Director of Discipline (DOD)" },
    { value: "director_of_studies",    label: "Director of Studies (DOS)" },
    { value: "finance_officer",        label: "Finance Officer" },
    { value: "school_admin",           label: "School Admin" },
  ],
  director_of_discipline: [
    { value: "patron",      label: "Patron" },
    { value: "matron",      label: "Matron" },
    { value: "gate_keeper", label: "Gate Keeper" },
    { value: "teacher",     label: "Teacher" },
    { value: "staff",       label: "Staff" },
  ],
  director_of_studies: [
    { value: "teacher", label: "Teacher" },
    { value: "staff",   label: "Staff" },
  ],
};

const ROLE_COLOR: Record<string, string> = {
  school_admin:           "#e11d48",
  director_of_discipline: "#7c3aed",
  director_of_studies:    "#2563eb",
  patron:                 "#1d4ed8",
  matron:                 "#be185d",
  gate_keeper:            "#b45309",
  teacher:                "#059669",
  staff:                  "#475569",
  finance_officer:        "#0e7490",
};

export default function UsersPanel({ schoolUser, onClose }: { schoolUser: any; onClose: () => void }) {
  const userRole     = schoolUser?.role ?? "";
  const allowedRoles = ROLE_OPTIONS[userRole] ?? [];
  const canManage    = allowedRoles.length > 0;

  const [users,      setUsers]      = useState<any[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [search,     setSearch]     = useState("");
  const [filterRole, setFilterRole] = useState("");
  const [showForm,   setShowForm]   = useState(false);
  const [editId,     setEditId]     = useState<string | null>(null);
  const [saving,     setSaving]     = useState(false);
  const [form,       setForm]       = useState({
    name: "", email: "", phone: "",
    role: allowedRoles[0]?.value ?? "teacher",
    password: "",
  });

  const loadUsers = async () => {
    setLoading(true);
    try {
      const r = await schoolApi.getUsers({ limit: "500" });
      setUsers((r.data as any)?.data ?? r.data ?? []);
    } catch { toast.error("Failed to load users"); }
    finally { setLoading(false); }
  };

  useEffect(() => { void loadUsers(); }, []);

  const resetForm = () => {
    setForm({ name: "", email: "", phone: "", role: allowedRoles[0]?.value ?? "teacher", password: "" });
    setEditId(null); setShowForm(false);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault(); setSaving(true);
    try {
      if (editId) {
        const body: any = { name: form.name, role: form.role };
        if (form.email)    body.email    = form.email;
        if (form.phone)    body.phone    = form.phone;
        if (form.password) body.password = form.password;
        await schoolApi.updateUser(editId, body);
        toast.success("User updated");
      } else {
        const body: any = { name: form.name, role: form.role, password: form.password };
        if (form.email) body.email = form.email;
        if (form.phone) body.phone = form.phone;
        await schoolApi.createUser(body);
        toast.success(`${form.name} created as ${form.role}`);
      }
      resetForm(); await loadUsers();
    } catch (e: any) { toast.error(e?.response?.data?.error ?? e?.message ?? "Failed"); }
    finally { setSaving(false); }
  };

  const handleDelete = async (u: any) => {
    if (!confirm(`Delete "${u.name}"?`)) return;
    try {
      await schoolApi.deleteUser(u.id);
      toast.success("User deleted"); await loadUsers();
    } catch (e: any) { toast.error(e?.response?.data?.error ?? "Failed"); }
  };

  const startEdit = (u: any) => {
    const isAllowed = allowedRoles.some(r => r.value === u.role) || userRole === "school_admin";
    if (!isAllowed) { toast.error("You cannot edit a user with that role"); return; }
    setEditId(u.id);
    setForm({ name: u.name ?? "", email: u.email ?? "", phone: u.phone ?? "", role: u.role, password: "" });
    setShowForm(true);
  };

  const filtered = users.filter(u => {
    const q = search.toLowerCase();
    return (!q || `${u.name ?? ""} ${u.email ?? ""}`.toLowerCase().includes(q))
      && (!filterRole || u.role === filterRole);
  });

  return (
    <div className="flex flex-col h-full text-white bg-slate-950">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-5 py-4 shrink-0">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-violet-500/15 p-2.5 text-violet-400">
            <FiUserCheck className="text-xl" />
          </div>
          <div>
            <h2 className="text-lg font-bold">User Management</h2>
            <p className="text-xs text-slate-400">
              {userRole === "school_admin" ? "Full access" :
               userRole === "director_of_discipline" ? "Boarding roles" :
               userRole === "director_of_studies" ? "Academic roles" : "View only"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canManage && (
            <button onClick={() => { resetForm(); setShowForm(true); }}
              className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 touch-manipulation">
              <FiPlus /> Create
            </button>
          )}
          <button onClick={onClose} className="rounded-xl p-3 text-slate-400 hover:bg-slate-800 hover:text-white touch-manipulation">
            <FiX className="text-lg" />
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 border-b border-slate-800 bg-slate-900/60 px-5 py-3 shrink-0">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name or email..."
          className="flex-1 min-w-48 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none" />
        <select value={filterRole} onChange={e => setFilterRole(e.target.value)}
          className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-white outline-none">
          <option value="">All roles</option>
          {(allowedRoles.length > 0 ? allowedRoles : [{value:"teacher",label:"Teacher"},{value:"staff",label:"Staff"}]).map(r => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
        <button onClick={() => void loadUsers()} disabled={loading}
          className="rounded-xl border border-slate-700 bg-slate-800 p-2.5 text-slate-400 hover:text-white disabled:opacity-40 touch-manipulation">
          <FiRefreshCw className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* User list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {loading ? (
          <div className="py-20 text-center text-slate-500 text-sm">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="py-20 text-center text-slate-500 text-sm">No users found</div>
        ) : filtered.map(u => (
          <div key={u.id} className="flex items-center gap-4 rounded-2xl border border-slate-700 bg-slate-900/60 px-4 py-3.5">
            <div className="h-11 w-11 shrink-0 rounded-full flex items-center justify-center font-bold text-sm"
              style={{ backgroundColor: `${ROLE_COLOR[u.role] ?? "#475569"}22`, color: ROLE_COLOR[u.role] ?? "#94a3b8" }}>
              {(u.name ?? "?").split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-sm">{u.name}</span>
                <span className="rounded-full px-2.5 py-0.5 text-[11px] font-bold capitalize"
                  style={{ backgroundColor: `${ROLE_COLOR[u.role] ?? "#475569"}22`, color: ROLE_COLOR[u.role] ?? "#94a3b8" }}>
                  {u.role?.replace(/_/g, " ")}
                </span>
                {u.status && u.status !== "active" && (
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-300">{u.status}</span>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-0.5 truncate">{u.email ?? u.phone ?? "No contact"}</p>
            </div>
            {canManage && (
              <div className="flex gap-1.5 shrink-0">
                <button onClick={() => startEdit(u)} title="Edit"
                  className="rounded-xl border border-slate-700 p-2.5 text-slate-400 hover:text-amber-400 hover:border-amber-500/40 transition touch-manipulation">
                  <FiSettings className="text-sm" />
                </button>
                <button onClick={() => void handleDelete(u)} title="Delete"
                  className="rounded-xl border border-slate-700 p-2.5 text-slate-400 hover:text-red-400 hover:border-red-500/40 transition touch-manipulation">
                  <FiTrash2 className="text-sm" />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Create / Edit modal */}
      {showForm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm overflow-y-auto">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl my-4">
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-xl font-bold">{editId ? "Edit User" : "Create User"}</h2>
              <button onClick={resetForm} className="rounded-xl p-2.5 text-slate-400 hover:bg-slate-800 hover:text-white touch-manipulation"><FiX /></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-400">Full Name *</label>
                <input value={form.name} onChange={e => setForm(f => ({...f, name: e.target.value}))}
                  required placeholder="e.g. Marie Uwase" className="form-field py-3 text-base" />
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-400">Role *</label>
                <select value={form.role} onChange={e => setForm(f => ({...f, role: e.target.value}))} className="form-field py-3">
                  {allowedRoles.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-400">Email</label>
                  <input type="email" value={form.email} onChange={e => setForm(f => ({...f, email: e.target.value}))}
                    placeholder="user@school.ac" className="form-field py-3" />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-400">Phone</label>
                  <input value={form.phone} onChange={e => setForm(f => ({...f, phone: e.target.value}))}
                    placeholder="+250..." className="form-field py-3" />
                </div>
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-400">
                  {editId ? "New Password (blank = keep current)" : "Password *"}
                </label>
                <input type="password" value={form.password} onChange={e => setForm(f => ({...f, password: e.target.value}))}
                  required={!editId} minLength={8}
                  placeholder={editId ? "Leave blank to keep current" : "Min 8 characters"}
                  className="form-field py-3" />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="submit" disabled={saving} className="primary-action flex-1 py-4 text-base font-bold touch-manipulation">
                  {saving ? "Saving..." : editId ? "Save Changes" : "Create User"}
                </button>
                <button type="button" onClick={resetForm} className="secondary-action px-6 py-4 touch-manipulation">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
