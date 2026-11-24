import type { ReactNode } from "react";

function Topic({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="help-topic">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** The help page in English; Help.tsx holds the Chinese one and picks between them. */
export function HelpEn({ statusLine }: { statusLine: string }) {
  return (
    <div className="help">
      <Topic title="The conversation list">
        <ul>
          <li>On a computer the page has three columns: navigation on the far left, the conversation list in the middle, the conversation on the right. On a phone, tools are switched at the top of the list.</li>
          <li>
            At the top of the left bar is <strong>Home</strong>: conversations still replying in every AI tool, grouped by tool. The number on the icon is how many; green means one is replying. A finished reply you have not seen stays here with a green bolt, and leaves once you have opened it and moved on.
          </li>
          <li>Below Home are Claude, Codex and Cursor. Click one to see all its conversations, grouped by folder. A tool whose app is not open on this computer is grey.</li>
          <li>
            Conversations <strong>pinned</strong> in Claude, Codex or Cursor are listed under Pinned at the top of that tool&apos;s list. Pin or unpin them in their own app; this follows along.
          </li>
          <li>
            The thin bar under a tool&apos;s name is its <strong>usage limit</strong>: green is fine, orange is over 80%, red is used up. Hover to see the percentage and when it resets.
          </li>
        </ul>
      </Topic>

      <Topic title="Carrying on and sending">
        <ul>
          <li>Click a conversation to open it. You can send while it is replying; the message is queued until the turn ends.</li>
          <li>
            A conversation started on this page has a bin at the top right to <strong>delete</strong> it, after you confirm. One used only from the command line has its record moved to the Windows Recycle Bin, where it can be restored; one handed to the Claude or Codex desktop app or to Cursor is only removed from this list. A conversation that is replying can be deleted once it finishes. Conversations started in an AI tool have no delete button; delete them in their own app.
          </li>
          <li>
            Typing <code>/</code> at the start of the input box opens <strong>slash commands</strong>: the tool&apos;s own commands (such as /compact, /model) plus your and the project&apos;s custom commands and skills. Keep typing to filter, ↑↓ to choose, Enter or Tab to fill it in, Esc to close; on a phone, tap. Add arguments, then send.
          </li>
          <li>For a conversation open in the Claude desktop app, messages are written into the app, so both sides see them.</li>
          <li>
            When the computer is <strong>locked</strong>, the desktop app cannot be typed into, so MirrorMix switches route: it writes into the running Claude process first, and if that fails, takes over the conversation with its own Claude; the input box says MirrorMix has taken over. Reopen the conversation in the desktop app to see what was added meanwhile, and do not send from the app at the same time.
          </li>
          <li>
            Cursor messages still go into the Cursor window while locked. A minimized window is fine: while locked it is restored in the background, sent, and minimized again; while unlocked the window is not pulled in front of you and Cursor&apos;s command line replies instead. If Cursor is on its settings page, that is closed first. Only when the window cannot send does Cursor&apos;s command line reply, which needs agent login run once in a terminal on the computer.
          </li>
          <li>
            When the Codex desktop app is open and has the conversation, messages go into the Codex window. While locked they go to Codex&apos;s background service; when the app is closed or cannot send, MirrorMix&apos;s own Codex replies, and you reopen the conversation in Codex to see it.
          </li>
        </ul>
      </Topic>

      <Topic title="New conversations">
        <ul>
          <li>In a tool&apos;s list, click the + to the right of a folder.</li>
          <li>
            A new Claude conversation is created when you send the first message. If the Claude desktop app is open, unlocked and lists that folder, it is created there and shows in the app&apos;s list, and the app switches to it. Otherwise MirrorMix&apos;s own Claude creates it and it shows only on this page.
          </li>
          <li>
            The first time Claude or Codex runs from the command line in a folder, it asks <strong>whether to trust the folder</strong>. Click Trust and continue on the page; it will not ask again.
          </li>
          <li>A new Codex conversation gets its real ID after the first message; the page follows it by itself.</li>
        </ul>
      </Topic>

      <Topic title="Terminal">
        <ul>
          <li>Click the terminal icon next to a conversation&apos;s title to open cmd in its folder.</li>
          <li>
            The 1, 2, 3 at the top are separate terminals; + opens another, up to 8 per conversation. The × on a tab ends that terminal; the × at the panel&apos;s top right only hides it, and it keeps running in the background.
          </li>
          <li>Shortcuts keeps commands you use often, run with one click.</li>
          <li>Services detects or lets you set the project&apos;s start commands. Each service runs in its own terminal tab and can be stopped or restarted on its own.</li>
          <li>On a phone, type the whole line in the box below and tap Run; Tab, ↑, ↓, Ctrl+C and Esc are next to it.</li>
          <li>Terminals end when MirrorMix restarts.</li>
        </ul>
      </Topic>

      <Topic title="Plugins">
        <ul>
          <li>In My plugins → Plugin market each plugin is a card; Add to My plugins adds it, and clicking again removes it. There are Command tasks, Scheduled tasks and SSH; the first two are added by default.</li>
          <li>
            Click Plugins at the bottom of the far-left bar to open the plugins page: added plugins are in the middle column, and one you click opens on the right; next time it opens on the last one used. Click Home or an AI tool to go back to conversations. On a phone it is the Plugins tab at the bottom.
          </li>
          <li>Which plugins are added is kept on this computer, so a phone and a computer see the same.</li>
        </ul>
      </Topic>

      <Topic title="SSH (plugin)">
        <ul>
          <li>
            Add hosts under Hosts: address, port, user name, and a sign-in method of password, key, identity or SSH Agent. Import ~/.ssh/config brings in existing hosts and keys at once. Hosts can go into (nested) groups and get tags and colours; search names, addresses, users and tags at the top.
          </li>
          <li>
            Click a host card to connect, which adds a terminal tab; a host can have several. Closing the page or switching to a phone leaves the terminal running in MirrorMix, and it carries on when you come back. Snippets above the terminal types common commands in one click, and SFTP opens the host&apos;s files.
          </li>
          <li>
            The first connection shows the server&apos;s <strong>host key fingerprint</strong>; check it, then click Trust and connect. Unconfirmed hosts have a shield icon by their name. If the fingerprint later changes, you get a red warning: the server may have been reinstalled, or someone may be impersonating it.
          </li>
          <li>
            Keychain generates keys (Ed25519 recommended), imports private keys, and copies public keys for a server&apos;s ~/.ssh/authorized_keys. An identity is a user name with a password (or key) that several hosts can share.
          </li>
          <li>
            SFTP: click folders to go in and use the path bar to go up; upload (or drag files in), download, create folders, rename, change permissions and delete. Deleting a folder deletes everything in it and cannot be undone.
          </li>
          <li>Passwords, private keys and passphrases are stored encrypted in %USERPROFILE%\.mirrormix\ssh.json; only your Windows account on this computer can unlock them, and the page never shows them.</li>
        </ul>
      </Topic>

      <Topic title="Files">
        <ul>
          <li>Click the folder icon next to a conversation&apos;s title to browse its folder: the file tree on the left, a preview on the right. Drag the divider to resize; double-click to reset.</li>
          <li>Click a folder to expand or collapse it and a file to preview it; ↑↓ move, → expands, ← collapses. At the top you can refresh, collapse all, and filter the expanded files.</li>
          <li>
            Previews: code and text with line numbers, Markdown laid out, images, PDFs, audio and video shown directly. HTML shows its source; Open as a web page runs it in a new tab. Other files can be downloaded.
          </li>
          <li>Only that conversation&apos;s folder can be viewed. On a phone a file previews full-screen; go back at the top left.</li>
        </ul>
      </Topic>

      <Topic title="Previewing generated pages">
        <ul>
          <li>Click the globe icon next to a conversation&apos;s title. The first time, choose which HTML files and local services (such as localhost:5173) this project previews; either kind, both or neither.</li>
          <li>The choice is kept per project folder and shared by its conversations, across refreshes and devices. Change it with Manage at the top right.</li>
          <li>
            The menu then shows only those, each opening in a new tab; images, styles and scripts next to the HTML load too, and a dev server reloads after code changes. A chosen service that is not running shows Not running; start it, then Refresh.
          </li>
          <li>The input box takes a port number or the full path of an HTML file.</li>
          <li>With remote access, the preview address is &quot;subdomain-preview&quot;, so a phone can see it too. Refresh the preview after the AI changes files.</li>
        </ul>
      </Topic>

      <Topic title="Where the limits come from">
        <ul>
          <li>
            <strong>Codex</strong>: Codex records its 5-hour limit after every reply, and it is read from there.
          </li>
          <li>
            <strong>Cursor</strong>: billed monthly, so it shows how much of <strong>this month&apos;s allowance</strong> is used; hover to see the plan, Auto and API usage and the reset day. It comes from /usage in Cursor&apos;s command line, read every 15 minutes, which needs agent login run once in a terminal on the computer.
          </li>
          <li>
            <strong>Claude</strong>: shows the <strong>5-hour limit</strong>, read from the Claude desktop app&apos;s usage panel. Opening that panel brings the Claude window to the front, so MirrorMix reads it only while the computer is locked (once a minute, closing it right after); while you are at the computer it keeps the last reading, and after 5 hours without one it shows the weekly limit. To keep it live while you are at the computer, you can have Claude&apos;s status line hand the data to MirrorMix (optional):
            <ol>
              <li>
                Open <code>%USERPROFILE%\.claude\settings.json</code> and add this inside the outermost braces:
                <pre>{statusLine}</pre>
                Change the path to where MirrorMix is on your computer; replace any existing statusLine.
              </li>
              <li>From then on, using Claude from the command line (including conversations MirrorMix starts) updates the 5-hour limit here.</li>
            </ol>
            Conversations in the Claude desktop app do not run the status line, so with only the desktop app this figure does not change.
          </li>
        </ul>
      </Topic>

      <Topic title="Remote access">
        <ul>
          <li>Request an address in the MirrorMix mini program first. Once approved, it shows the subdomain and connection token.</li>
          <li>Turn on the switch in Settings → General → Remote access, fill in both, save, then visit https://subdomain.mm.seekmeans.cn.</li>
          <li>frpc.exe is built into MirrorMix and runs by itself while remote access is on; there is nothing to download or set.</li>
          <li>Remote sign-in uses this computer&apos;s Windows account and password.</li>
        </ul>
      </Topic>

      <Topic title="Common questions">
        <dl>
          <dt>A message will not send</dt>
          <dd>Read the note above the input box first. While locked the route switches by itself; if it says this turn is still going, wait for it or send to queue.</dd>
          <dt>A conversation shows &quot;Process exited&quot; right after opening</dt>
          <dd>The red note has the program&apos;s last output. Usually the CLI is not installed or not signed in; run claude or codex once in a terminal on the computer.</dd>
          <dt>A preview opens to &quot;open it from MirrorMix&quot;</dt>
          <dd>A preview link works once and for one minute. Go back to MirrorMix and click the globe again.</dd>
          <dt>A code change did not take effect</dt>
          <dd>
            Started with npm run dev, changes apply by themselves: page changes refresh directly, and server changes restart MirrorMix, which ends open terminals and taken-over conversations. Started with npm start, nothing updates by itself; press Ctrl+C and start it again.
          </dd>
        </dl>
      </Topic>
    </div>
  );
}
