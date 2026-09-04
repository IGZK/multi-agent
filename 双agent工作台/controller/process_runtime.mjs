import { execFile } from "node:child_process";

/** Await termination before callers roll back or remove a process's workspace. */
export async function terminateProcessTree(childOrPid) {
  const child = typeof childOrPid === "object" ? childOrPid : null;
  const pid = child?.pid ?? childOrPid;
  if (child && !child.pid) return true; // spawn failed before a process existed
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  if (child && (child.exitCode != null || child.signalCode != null)) return true;
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10000 }, (error) => {
        if (!error) return resolve(true);
        // Killing only the parent would leave children writing into a workspace
        // that callers are about to restore/delete. Keep failure observable.
        try { process.kill(pid, 0); resolve(false); }
        catch (probeError) { resolve(probeError.code === "ESRCH"); }
      });
    });
  }
  const exited = child ? new Promise((resolve) => child.once("exit", resolve)) : null;
  try { process.kill(-pid, "SIGKILL"); }
  catch {
    try { process.kill(pid, "SIGKILL"); } catch (error) { return error.code === "ESRCH"; }
  }
  if (exited) await exited;
  return true;
}
