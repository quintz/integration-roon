/* eslint-disable n/no-callback-literal -- Roon browse callbacks use `false` for "no error" */
import test from "ava";
import { StatusCodes } from "@unfoldedcircle/integration-api";
import type RoonApiBrowse from "node-roon-api-browse";
import type {
  Item,
  RoonApiBrowseLoadOptions,
  RoonApiBrowseLoadResponse,
  RoonApiBrowseOptions,
  RoonApiBrowseResponse
} from "node-roon-api-browse";
import { BrowseService } from "../src/roon-browse.js";

interface Node {
  title: string;
  subtitle?: string;
  hint?: Item["hint"];
  children?: Node[];
  /** Called when an action item is browsed. */
  onAction?: () => void;
}

/**
 * Minimal stateful mock of the Roon browse service: one browse stack, item keys are "<level>:<index>".
 */
class MockRoonBrowse {
  stack: Node[];
  actions: string[] = [];

  constructor(private root: Node) {
    this.stack = [root];
  }

  private current(): Node {
    return this.stack[this.stack.length - 1]!;
  }

  browse(opts: RoonApiBrowseOptions, cb: (err: string | false, body: RoonApiBrowseResponse) => void) {
    if (opts.pop_all) {
      this.stack = [this.root];
    } else if (opts.item_key) {
      const [level, index] = opts.item_key.split(":").map(Number);
      // like Roon: an item key of a parent level is still valid and navigates back to that level
      if (level! < this.stack.length - 1) {
        this.stack = this.stack.slice(0, level! + 1);
      }
      const node = level === this.stack.length - 1 ? this.current().children?.[index!] : undefined;
      if (!node) {
        cb("InvalidItemKey", {} as RoonApiBrowseResponse);
        return;
      }
      if (node.hint === "action") {
        this.actions.push(node.title);
        node.onAction?.();
        cb(false, { action: "none" } as RoonApiBrowseResponse);
        return;
      }
      this.stack.push(node);
    }
    const list = this.current();
    cb(false, {
      action: "list",
      list: { level: this.stack.length - 1, title: list.title, count: list.children?.length ?? 0 }
    } as RoonApiBrowseResponse);
  }

  load(opts: RoonApiBrowseLoadOptions, cb: (err: string | false, body: RoonApiBrowseLoadResponse) => void) {
    const level = this.stack.length - 1;
    const list = this.current();
    const offset = opts.offset ?? 0;
    const items = (list.children ?? []).slice(offset, offset + (opts.count ?? 100)).map((node, i) => ({
      title: node.title,
      subtitle: node.subtitle,
      hint: node.hint,
      item_key: `${level}:${offset + i}`
    }));
    cb(false, {
      items,
      offset,
      list: { level, title: list.title, count: list.children?.length ?? 0 }
    } as RoonApiBrowseLoadResponse);
  }
}

function profileTree(selected: string, profiles: string[], applySelection = true) {
  const profileNodes: Node[] = profiles.map((name) => ({ title: name, hint: "action" }));
  const settings: Node = { title: "Settings", hint: "list", children: [] };
  const refresh = () => {
    profileNodes.forEach((p) => (p.subtitle = p.title === selected ? "selected" : undefined));
    settings.children = [{ title: "Profile", subtitle: selected, hint: "list", children: profileNodes }];
  };
  profileNodes.forEach((p) => {
    p.onAction = () => {
      if (applySelection) {
        selected = p.title;
        refresh();
      }
    };
  });
  refresh();
  return {
    title: "Explore",
    children: [
      { title: "Library", hint: "list", children: [] },
      { title: "Playlists", hint: "list", children: [] },
      settings
    ]
  } as Node;
}

function service(mock: MockRoonBrowse) {
  return new BrowseService(mock as unknown as RoonApiBrowse, {}, "127.0.0.1", 9330);
}

test("listProfiles: returns all profiles and marks the selected one", async (t) => {
  const mock = new MockRoonBrowse(profileTree("Familie", ["Familie", "Quirin"]));
  const profiles = await service(mock).listProfiles();
  t.deepEqual(profiles, [
    { name: "Familie", selected: true },
    { name: "Quirin", selected: false }
  ]);
});

test("selectProfile: selects the profile and leaves the browse session at the root", async (t) => {
  const mock = new MockRoonBrowse(profileTree("Familie", ["Familie", "Quirin"]));
  const browse = service(mock);
  t.is(await browse.selectProfile("Quirin"), "selected");
  t.deepEqual(mock.actions, ["Quirin"]);
  t.is(mock.stack.length, 1);
  t.deepEqual(
    (await browse.listProfiles()).find((p) => p.selected),
    { name: "Quirin", selected: true }
  );
});

test("selectProfile: already selected profile isn't selected again", async (t) => {
  const mock = new MockRoonBrowse(profileTree("Quirin", ["Familie", "Quirin"]));
  t.is(await service(mock).selectProfile("Quirin"), "already_selected");
  t.deepEqual(mock.actions, []);
});

test("selectProfile: unknown profile", async (t) => {
  const mock = new MockRoonBrowse(profileTree("Familie", ["Familie", "Quirin"]));
  t.is(await service(mock).selectProfile("Gast"), "not_found");
});

test("selectProfile: detects that Roon ignored the selection", async (t) => {
  const mock = new MockRoonBrowse(profileTree("Familie", ["Familie", "Quirin"], false));
  t.is(await service(mock).selectProfile("Quirin"), "not_applied");
});

test("selectProfile: no Settings menu", async (t) => {
  const mock = new MockRoonBrowse({ title: "Explore", children: [{ title: "Library", hint: "list", children: [] }] });
  t.is(await service(mock).selectProfile("Quirin"), "unsupported");
  t.deepEqual(await service(mock).listProfiles(), []);
});

function playlistTree() {
  return {
    title: "Explore",
    children: [
      {
        title: "Playlists",
        hint: "list",
        children: [
          // local playlist of another profile: Roon only returns "Not Found"
          { title: "Lieblingslieder", subtitle: "775 Tracks", hint: "list", children: [{ title: "Not Found" }] },
          // TIDAL folder with playlists
          {
            title: "Training",
            hint: "list",
            children: [{ title: "In Bewegung", subtitle: "65 Tracks", hint: "list", children: [] }]
          },
          {
            title: "Jazz Café",
            hint: "list",
            children: [
              {
                title: "Play Playlist",
                hint: "action_list",
                children: [{ title: "Play Now", hint: "action" }]
              }
            ]
          }
        ]
      }
    ]
  } as Node;
}

async function openPlaylists(mock: MockRoonBrowse) {
  // the Remote browses Explore > Playlists before it sends play_media with the item key
  mock.browse({ hierarchy: "browse", pop_all: true }, () => {});
  mock.browse({ hierarchy: "browse", item_key: "0:0" }, () => {});
}

test("playItemById: playlist Roon can't open returns NotFound instead of ServerError", async (t) => {
  const mock = new MockRoonBrowse(playlistTree());
  await openPlaylists(mock);
  t.is(await service(mock).playItemById("zone-1", "1:0"), StatusCodes.NotFound);
});

test("playItemById: folder returns BadRequest instead of ServerError", async (t) => {
  const mock = new MockRoonBrowse(playlistTree());
  await openPlaylists(mock);
  t.is(await service(mock).playItemById("zone-1", "1:1"), StatusCodes.BadRequest);
});

test("playItemById: playlist with 'Play Playlist' action plays", async (t) => {
  const mock = new MockRoonBrowse(playlistTree());
  await openPlaylists(mock);
  t.is(await service(mock).playItemById("zone-1", "1:2"), StatusCodes.Ok);
  t.deepEqual(mock.actions, ["Play Now"]);
});

test("playItemByPath: playlist Roon can't open returns NotFound", async (t) => {
  const mock = new MockRoonBrowse(playlistTree());
  t.is(await service(mock).playItemByPath("zone-1", ["Playlists", "Lieblingslieder"]), StatusCodes.NotFound);
});
