import { describe, expect, it } from "vitest";
import type { RunUpdateOptions } from "axi-sdk-js";
import {
  detectLinkedCheckout,
  findPathCopies,
  resolveBinTarget,
  updateCommand,
  type UpdateDeps,
} from "../src/commands/update.js";
import { VERSION } from "../src/version.js";

const PKG = "@simkimsia/cloudflare-axi";
const CHECKOUT = "/Users/jane/Projects/axi/cloudflare-axi";
const CHECKOUT_ENTRY = `${CHECKOUT}/dist/bin/cloudflare-axi.js`;
const PNPM_HOME = "/Users/jane/Library/pnpm";
const PNPM_LINK = `${PNPM_HOME}/global/5/node_modules/${PKG}`;
const NPM_ROOT = "/Users/jane/.nvm/versions/node/v24.11.1";
const NPM_PKG = `${NPM_ROOT}/lib/node_modules/${PKG}`;
const NPM_ENTRY = `${NPM_PKG}/dist/bin/cloudflare-axi.js`;

// The shim `pnpm link --global` writes to $PNPM_HOME (pnpm 10, trimmed).
const PNPM_SHIM = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/global/5/node_modules/${PKG}/dist/bin/cloudflare-axi.js" "$@"
else
  exec node  "$basedir/global/5/node_modules/${PKG}/dist/bin/cloudflare-axi.js" "$@"
fi
`;

interface Fixture {
  files: Record<string, string>;
  dirs?: string[];
  links?: Record<string, string>;
  invokedAs: string;
  path: string[];
  latest?: string;
  platform?: NodeJS.Platform;
}

function makeDeps(fx: Fixture) {
  const calls: RunUpdateOptions[] = [];
  const dirs = new Set(fx.dirs ?? []);
  const links = fx.links ?? {};
  const realpath = (path: string): string => {
    for (const [from, to] of Object.entries(links)) {
      if (path === from || path.startsWith(`${from}/`)) {
        return to + path.slice(from.length);
      }
    }
    return path;
  };
  const deps: UpdateDeps = {
    invokedAs: fx.invokedAs,
    env: { PATH: fx.path.join(fx.platform === "win32" ? ";" : ":") },
    platform: fx.platform ?? "darwin",
    existsSync: (p) => dirs.has(realpath(p)) || realpath(p) in fx.files,
    isDirectory: (p) => dirs.has(realpath(p)),
    readFileSync: (p) => {
      const text = fx.files[realpath(p)];
      if (text === undefined) throw new Error(`ENOENT ${p}`);
      return text;
    },
    realpath,
    runUpdate: async (options) => {
      calls.push(options);
      const latest = fx.latest ?? "0.2.3";
      const current = options.version!;
      const available = latest !== current;
      if (options.args[0] === "--check") {
        return {
          update: { package: PKG, current, latest, available },
          ...(available
            ? { help: ["Run `cloudflare-axi update` to upgrade"] }
            : {}),
        };
      }
      return {
        update: `${PKG} upgraded ${current} -> ${latest}`,
        command: "npm install -g x",
      };
    },
    stdout: { write: () => true },
  };
  return { deps, calls };
}

const pkgJson = (version: string) => JSON.stringify({ name: PKG, version });

// The issue #56 machine: a pnpm link to a checkout on a feature branch,
// ahead on PATH of an npm-installed copy.
function issueMachine(overrides: Partial<Fixture> = {}): Fixture {
  return {
    files: {
      [`${CHECKOUT}/package.json`]: pkgJson("0.2.1"),
      [`${CHECKOUT}/.git/HEAD`]: "ref: refs/heads/feat/kv-drop\n",
      [CHECKOUT_ENTRY]: "#!/usr/bin/env node\n",
      [`${PNPM_HOME}/cloudflare-axi`]: PNPM_SHIM,
      [`${NPM_PKG}/package.json`]: pkgJson("0.2.3"),
      [NPM_ENTRY]: "#!/usr/bin/env node\n",
    },
    dirs: [`${CHECKOUT}/.git`],
    links: {
      [PNPM_LINK]: CHECKOUT,
      [`${NPM_ROOT}/bin/cloudflare-axi`]: NPM_ENTRY,
    },
    invokedAs: `${PNPM_LINK}/dist/bin/cloudflare-axi.js`,
    path: [PNPM_HOME, "/usr/bin", `${NPM_ROOT}/bin`],
    ...overrides,
  };
}

describe("install inspection", () => {
  it("detects a linked checkout and its branch", () => {
    const { deps } = makeDeps(issueMachine());
    expect(detectLinkedCheckout(CHECKOUT_ENTRY, deps)).toEqual({
      path: CHECKOUT,
      branch: "feat/kv-drop",
    });
  });

  it("follows a worktree's .git file and reports a detached HEAD", () => {
    const fx = issueMachine();
    fx.dirs = [];
    fx.files[`${CHECKOUT}/.git`] = "gitdir: ../main/.git/worktrees/x\n";
    fx.files["/Users/jane/Projects/axi/main/.git/worktrees/x/HEAD"] =
      "0123456789abcdef0123456789abcdef01234567\n";
    const { deps } = makeDeps(fx);
    expect(detectLinkedCheckout(CHECKOUT_ENTRY, deps)?.branch).toBe(
      "detached 0123456",
    );
  });

  it("never treats an install under node_modules as a checkout", () => {
    const fx = issueMachine();
    fx.files[`${NPM_PKG}/.git/HEAD`] = "ref: refs/heads/main\n";
    const { deps } = makeDeps(fx);
    expect(detectLinkedCheckout(NPM_ENTRY, deps)).toBeUndefined();
  });

  it("follows a pnpm shell shim and an npm symlink to their entry", () => {
    const { deps } = makeDeps(issueMachine());
    expect(resolveBinTarget(`${PNPM_HOME}/cloudflare-axi`, deps)).toBe(
      CHECKOUT_ENTRY,
    );
    expect(resolveBinTarget(`${NPM_ROOT}/bin/cloudflare-axi`, deps)).toBe(
      NPM_ENTRY,
    );
  });

  it("lists every copy on PATH in PATH order, deduplicated", () => {
    const fx = issueMachine();
    fx.path = [PNPM_HOME, `${NPM_ROOT}/bin`, PNPM_HOME];
    const { deps } = makeDeps(fx);
    expect(findPathCopies(deps)).toEqual([
      {
        path: `${PNPM_HOME}/cloudflare-axi`,
        target: CHECKOUT_ENTRY,
        version: "0.2.1",
      },
      {
        path: `${NPM_ROOT}/bin/cloudflare-axi`,
        target: NPM_ENTRY,
        version: "0.2.3",
      },
    ]);
  });
});

describe("Windows PATH copies", () => {
  // The sh shim npm's cmd-shim writes next to cloudflare-axi.cmd (trimmed).
  const NPM_SH_SHIM = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/node_modules/${PKG}/dist/bin/cloudflare-axi.js" "$@"
else
  exec node  "$basedir/node_modules/${PKG}/dist/bin/cloudflare-axi.js" "$@"
fi
`;
  const PREFIX = "/Users/jane/AppData/Roaming/npm";
  const ENTRY = `${PREFIX}/node_modules/${PKG}/dist/bin/cloudflare-axi.js`;

  it("follows npm's shim beside the .cmd to the entry it runs", async () => {
    const { deps } = makeDeps({
      ...issueMachine(),
      platform: "win32",
      files: {
        ...issueMachine().files,
        [`${PREFIX}/cloudflare-axi.cmd`]: "@ECHO off\r\n",
        [`${PREFIX}/cloudflare-axi`]: NPM_SH_SHIM,
        [`${PREFIX}/node_modules/${PKG}/package.json`]: pkgJson("0.2.3"),
        [ENTRY]: "#!/usr/bin/env node\n",
      },
      invokedAs: ENTRY,
      path: [PREFIX, PNPM_HOME],
    });
    expect(findPathCopies(deps)[0]).toEqual({
      path: `${PREFIX}/cloudflare-axi`,
      target: ENTRY,
      version: "0.2.3",
    });
    const out = await updateCommand(["--check"], deps);
    expect(out).toMatch(/cloudflare-axi,0\.2\.3,yes,yes/);
    expect(out).not.toContain("does not change what");
  });
});

describe("update", () => {
  it("never npm-installs over a linked checkout; names the checkout, branch and rebuild", async () => {
    const { deps, calls } = makeDeps(issueMachine({ latest: "9.9.9" }));
    const out = await updateCommand([], deps);
    expect(calls.map((c) => c.args)).toEqual([["--check"]]);
    expect(out).toContain("install: linked checkout");
    expect(out).toContain(`checkout: ${CHECKOUT}`);
    expect(out).toContain("branch: feat/kv-drop");
    expect(out).toContain("action: manual");
    expect(out).toContain(
      `git -C ${CHECKOUT} pull --ff-only && pnpm -C ${CHECKOUT} install && pnpm -C ${CHECKOUT} run build`,
    );
    expect(out).not.toContain("npm install -g @");
    expect(out).not.toContain("switch main");
    // Both PATH copies, with the link winning and marked as this copy.
    expect(out).toContain("2 copies of cloudflare-axi are on PATH");
    expect(out).toMatch(/cloudflare-axi,0\.2\.1,yes,yes/);
    expect(out).toMatch(/cloudflare-axi,0\.2\.3,no \(shadowed\),no/);
  });

  it("--check on a linked checkout reports the same, without a rebuild when current", async () => {
    const { deps } = makeDeps(issueMachine({ latest: VERSION }));
    const out = await updateCommand(["--check"], deps);
    expect(out).toContain("available: false");
    expect(out).toContain("install: linked checkout");
    expect(out).not.toContain("action: manual");
  });

  it("warns when the copy being updated is shadowed by a link on PATH", async () => {
    const { deps, calls } = makeDeps(
      issueMachine({
        invokedAs: `${NPM_ROOT}/bin/cloudflare-axi`,
        latest: "9.9.9",
      }),
    );
    const out = await updateCommand([], deps);
    expect(calls.map((c) => c.args)).toEqual([[]]);
    expect(out).toContain("upgraded");
    expect(out).toContain("does not change what `cloudflare-axi` runs");
    expect(out).toContain(`linked to ${CHECKOUT} (branch feat/kv-drop)`);
    expect(out).not.toContain("pnpm rm");
  });

  it("gives no rebuild hint for a linked checkout that another copy shadows", async () => {
    const { deps } = makeDeps(
      issueMachine({
        path: [`${NPM_ROOT}/bin`, PNPM_HOME],
        latest: "9.9.9",
      }),
    );
    const out = await updateCommand([], deps);
    expect(out).toContain("install: linked checkout");
    expect(out).toContain(`checkout: ${CHECKOUT}`);
    expect(out).not.toContain("action: manual");
    expect(out).not.toContain("pull --ff-only");
    expect(out).toContain("does not change what `cloudflare-axi` runs");
  });

  it("drops the SDK's upgrade hint for an npm copy that a link shadows", async () => {
    const { deps } = makeDeps(
      issueMachine({
        invokedAs: `${NPM_ROOT}/bin/cloudflare-axi`,
        latest: "9.9.9",
      }),
    );
    const out = await updateCommand(["--check"], deps);
    expect(out).toContain("available: true");
    expect(out).not.toContain("Run `cloudflare-axi update` to upgrade");
    expect(out).toContain("does not change what `cloudflare-axi` runs");
  });

  it("passes the SDK result through for a lone npm install", async () => {
    const fx = issueMachine({
      invokedAs: `${NPM_ROOT}/bin/cloudflare-axi`,
      path: [`${NPM_ROOT}/bin`],
      latest: "9.9.9",
    });
    const { deps } = makeDeps(fx);
    const out = await updateCommand(["--check"], deps);
    expect(out).toContain("available: true");
    expect(out).toContain("Run `cloudflare-axi update` to upgrade");
    expect(out).not.toContain("copies");
  });

  it("gives no rebuild hint for an unlinked clone when PATH holds one other copy", async () => {
    // A clone run by path while the only PATH copy is the npm install.
    const { deps } = makeDeps(
      issueMachine({
        invokedAs: CHECKOUT_ENTRY,
        path: [`${NPM_ROOT}/bin`],
        latest: "9.9.9",
      }),
    );
    const out = await updateCommand([], deps);
    expect(out).not.toContain("action: manual");
    expect(out).not.toContain("pull --ff-only");
    expect(out).toContain(
      `not the one \`cloudflare-axi\` runs (${NPM_ROOT}/bin/cloudflare-axi, 0.2.3)`,
    );
    expect(out).not.toContain("copies of cloudflare-axi");
  });

  it("treats the checkout's own source entry as the linked copy that runs", async () => {
    // `tsx bin/cloudflare-axi.ts` in the checkout the PATH link points at.
    const fx = issueMachine({
      invokedAs: `${CHECKOUT}/bin/cloudflare-axi.ts`,
      latest: "9.9.9",
    });
    fx.files[`${CHECKOUT}/bin/cloudflare-axi.ts`] = "";
    const { deps } = makeDeps(fx);
    const out = await updateCommand([], deps);
    expect(out).toContain("action: manual");
    expect(out).not.toContain("does not change what");
    expect(out).toMatch(/cloudflare-axi,0\.2\.1,yes,yes/);
  });

  it("keeps the SDK's upgrade hint when the PATH copy is a shim it cannot follow", async () => {
    // asdf's shim re-execs through asdf, so it names no JS entry.
    const shims = "/Users/jane/.asdf/shims";
    const fx = issueMachine({
      invokedAs: NPM_ENTRY,
      path: [shims],
      latest: "9.9.9",
    });
    fx.files[`${shims}/cloudflare-axi`] =
      '#!/usr/bin/env bash\nexec /opt/asdf/bin/asdf exec "cloudflare-axi" "$@"\n';
    const { deps } = makeDeps(fx);
    const out = await updateCommand(["--check"], deps);
    expect(out).toContain("Run `cloudflare-axi update` to upgrade");
    expect(out).not.toContain("does not change what");
  });

  it("marks a copy it cannot identify as unknown, not as another copy", async () => {
    const shims = "/Users/jane/.asdf/shims";
    const fx = issueMachine({
      invokedAs: NPM_ENTRY,
      path: [shims, `${NPM_ROOT}/bin`],
      latest: "9.9.9",
    });
    fx.files[`${shims}/cloudflare-axi`] =
      '#!/usr/bin/env bash\nexec /opt/asdf/bin/asdf exec "cloudflare-axi" "$@"\n';
    const { deps } = makeDeps(fx);
    const out = await updateCommand(["--check"], deps);
    expect(out).not.toContain("does not change what");
    expect(out).toMatch(/shims\/cloudflare-axi,unknown,yes,unknown/);
    expect(out).toMatch(/bin\/cloudflare-axi,0\.2\.3,no \(shadowed\),yes/);
  });

  it("ignores an unrelated package.json above an unfollowable shim", async () => {
    // `npm init -y` in the home directory sits above ~/.asdf/shims.
    const shims = "/Users/jane/.asdf/shims";
    const fx = issueMachine({
      invokedAs: NPM_ENTRY,
      path: [shims, `${NPM_ROOT}/bin`],
      latest: "9.9.9",
    });
    fx.files[`${shims}/cloudflare-axi`] =
      '#!/usr/bin/env bash\nexec /opt/asdf/bin/asdf exec "cloudflare-axi" "$@"\n';
    fx.files["/Users/jane/package.json"] = JSON.stringify({
      name: "jane",
      version: "1.0.0",
    });
    const { deps } = makeDeps(fx);
    const out = await updateCommand(["--check"], deps);
    expect(out).not.toContain("does not change what");
    expect(out).toMatch(/shims\/cloudflare-axi,unknown,yes,unknown/);
  });

  it("rejects unknown flags with VALIDATION_ERROR", async () => {
    const { deps, calls } = makeDeps(issueMachine());
    await expect(updateCommand(["--force"], deps)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(calls).toEqual([]);
  });
});
