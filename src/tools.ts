import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ApiError, authorSegment, compactTracks, type HearthisClient, type Params, redact, requestContext, segment, toText, XHR_BASE } from './client.js';

type Shape = z.ZodRawShape;

interface ToolDef<S extends Shape> {
  title: string;
  description: string;
  input: S;
  /** add: only adds (comment, message, entry); write: overwrites, undoes or publishes; destructive: deletes */
  kind: 'read' | 'add' | 'write' | 'destructive';
  /** keep full track objects (single-track answers) */
  full?: boolean;
  run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

const author = z.string().min(1).describe('Profile permalink, e.g. "djname" from https://hearthis.at/djname/');
const track = z.string().min(1).describe('Track permalink, e.g. "my-mix" from https://hearthis.at/djname/my-mix/');
const page = z.number().int().min(1).optional().describe('Page, starting at 1');
const count = (max: number, fallback: number) =>
  z.number().int().min(1).max(max).default(fallback).describe(`Items per page (max ${max})`);
const flag = z.boolean().optional();
const iso = z.string().optional().describe('ISO 8601 with UTC offset, e.g. 2026-07-01T20:00:00+02:00');
const trackPath = (a: string, t: string, action = '') => `/${authorSegment(a)}/${segment(t)}/${action ? action + '/' : ''}`;
const bit = (value: boolean | undefined) => (value === undefined ? undefined : value ? 1 : 0);

const ANNOTATIONS: Record<ToolDef<Shape>['kind'], ToolAnnotations> = {
  read: { readOnlyHint: true, openWorldHint: true },
  add: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  write: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

/** What a tool handler gets besides its arguments (RequestHandlerExtra of the SDK, the parts used here). */
interface CallExtra {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: { method: 'notifications/progress'; params: Record<string, unknown> }) => Promise<void>;
}

const PROGRESS_EVERY_MS = 10_000;

export function registerTools(server: McpServer, api: HearthisClient): void {
  const tool = <S extends Shape>(name: string, def: ToolDef<S>) => {
    server.registerTool(
      name,
      { title: def.title, description: def.description, inputSchema: def.input, annotations: { title: def.title, ...ANNOTATIONS[def.kind] } },
      (async (args: z.infer<z.ZodObject<S>>, extra?: CallExtra) => {
        // A long call (an upload) reports progress, so a client that asked for it keeps waiting; a cancelled call aborts its request
        const token = extra?._meta?.progressToken;
        let beats = 0;
        const timer =
          token !== undefined && extra?.sendNotification
            ? setInterval(() => {
                extra.sendNotification?.({ method: 'notifications/progress', params: { progressToken: token, progress: ++beats, message: 'Waiting for hearthis.at' } }).catch(() => {});
              }, PROGRESS_EVERY_MS)
            : undefined;
        try {
          return await requestContext.run({ signal: extra?.signal }, async () => {
            await api.ensurePremium();
            const data = await def.run(args);
            return { content: [{ type: 'text' as const, text: api.scrub(toText(redact(def.full ? data : compactTracks(data)))) }] };
          });
        } catch (error) {
          const message = error instanceof ApiError || error instanceof Error ? error.message : String(error);
          return { isError: true, content: [{ type: 'text' as const, text: api.scrub(message) }] };
        } finally {
          clearInterval(timer);
        }
      }) as never,
    );
  };

  // Account and discovery

  tool('whoami', {
    title: 'Who am I',
    description: 'The hearthis.at account this server acts as: id, permalink, name, counts and Premium state.',
    input: {},
    kind: 'read',
    run: () => api.get('/login/'),
  });

  tool('get_feed', {
    title: 'Feed',
    description: 'Newest public tracks on hearthis.at, or the popular ones (optionally within one genre).',
    input: {
      type: z.enum(['recent', 'popular']).default('recent'),
      genre: z.string().optional().describe('Genre slug for type=popular, e.g. "techno" (see list_genres)'),
      page,
      count: count(50, 10),
      duration_min: z.number().int().min(0).optional().describe('Minimum length in minutes'),
      duration_max: z.number().int().min(0).optional().describe('Maximum length in minutes'),
    },
    kind: 'read',
    run: ({ type, genre, ...rest }) => api.get('/feed/', { type: type === 'popular' ? 'popular' : undefined, category: genre, ...rest }),
  });

  tool('list_genres', {
    title: 'Genres',
    description: 'All genres with their ids and slugs. Includes "later" once the account saved something to Listen later.',
    input: {},
    kind: 'read',
    run: () => api.get('/categories/'),
  });

  tool('get_genre_tracks', {
    title: 'Genre tracks',
    description: 'Tracks of one genre, newest first.',
    input: {
      genre: z.string().min(1).describe('Genre id or slug from list_genres'),
      page,
      count: count(50, 10),
      duration_min: z.number().int().min(0).optional(),
      duration_max: z.number().int().min(0).optional(),
    },
    kind: 'read',
    run: ({ genre, ...rest }) => api.get(`/categories/${segment(genre)}/`, rest),
  });

  tool('get_home_section', {
    title: 'Home section',
    description:
      'One section of the hearthis.at home screen: stories (banners), latest_artists (featured artists), moods, ' +
      'newcomers (first upload in the last 7 days), genres_today (sounds per genre in the last 24 h), premium (plans and running promotion).',
    input: {
      section: z.enum(['stories', 'latest_artists', 'moods', 'newcomers', 'genres_today', 'premium']),
      genre: z.string().optional().describe('newcomers only: genre id from list_genres'),
      page,
      count: z.number().int().min(1).max(50).optional().describe('newcomers (max 20) and genres_today (max 50)'),
    },
    kind: 'read',
    run: ({ section, genre, page: p, count: c }) =>
      api.get(`/app/${section}/`, section === 'newcomers' ? { category: genre, page: p, count: c } : section === 'genres_today' ? { count: c } : {}),
  });

  tool('search', {
    title: 'Search',
    description: 'Search tracks, artists (users) or playlists by text.',
    input: {
      type: z.enum(['tracks', 'user', 'playlists']),
      query: z.string().min(1),
      page,
      count: count(50, 10),
    },
    kind: 'read',
    run: ({ query, ...rest }) => api.get('/search/', { t: query, ...rest }),
  });

  tool('get_events', {
    title: 'Events',
    description: 'Upcoming events (gigs, live shows), or one event with its id.',
    input: {
      id: z.number().int().optional().describe('Event id - returns only that event'),
      from: z.string().optional().describe('Start date YYYY-MM-DD, default today'),
      to: z.string().optional().describe('End date YYYY-MM-DD'),
      author_id: z.number().int().optional().describe('Only events by or with this user id'),
      followed_only: flag.describe('Only events of followed artists'),
      page,
      count: count(100, 20),
    },
    kind: 'read',
    run: ({ id, author_id, followed_only, count: c, ...rest }) =>
      api.get('/events.php', { mode: id ? 'single' : 'list', id, author: author_id, followed_only: bit(followed_only), per_page: c, ...rest }),
  });

  tool('get_listen_history', {
    title: 'Listen history',
    description: 'Tracks the account listened to recently.',
    input: { count: count(100, 20) },
    kind: 'read',
    run: (args) => api.get('/categories/history/', args),
  });

  tool('get_listen_later', {
    title: 'Listen later',
    description: 'The Listen later list of the account, newest first.',
    input: { page, count: count(100, 20) },
    kind: 'read',
    run: (args) => api.get('/categories/later/', args),
  });

  // Tracks

  tool('get_track', {
    title: 'Track',
    description: 'Metadata of one track: title, artist, genre, duration, counts, stream and artwork URLs.',
    input: { author, track },
    kind: 'read',
    full: true,
    run: ({ author: a, track: t }) => api.get(trackPath(a, t)),
  });

  tool('get_track_part', {
    title: 'Track part',
    description:
      'More about one track: playlist (chapters / tracklist), transcript (AI transcript), related (similar tracks), ' +
      'reactions (emoji reactions) or comments.',
    input: { author, track, part: z.enum(['playlist', 'transcript', 'related', 'reactions', 'comments']) },
    kind: 'read',
    run: ({ author: a, track: t, part }) => api.get(trackPath(a, t, part)),
  });

  tool('toggle_like', {
    title: 'Like / unlike',
    description: 'Likes a track, or removes the like when it is already liked. The answer says the new state.',
    input: { author, track },
    kind: 'write',
    run: ({ author: a, track: t }) => api.get(trackPath(a, t, 'like')),
  });

  tool('toggle_repost', {
    title: 'Repost / undo repost',
    description: 'Reposts a track to the account\'s followers, or takes the repost back when it already exists.',
    input: { author, track },
    kind: 'write',
    run: ({ author: a, track: t }) => api.get(trackPath(a, t, 'reshare')),
  });

  tool('set_listen_later', {
    title: 'Listen later',
    description: 'Saves a track of someone else to Listen later (on=true), removes it (on=false), or toggles (on omitted).',
    input: { author, track, on: flag },
    kind: 'write',
    run: ({ author: a, track: t, on }) => api.get(trackPath(a, t, 'later'), { on: bit(on) }),
  });

  tool('get_cast_url', {
    title: 'Cast URL',
    description: 'A signed MP3 URL of a track for a cast receiver, valid 12 hours; fetching it counts as a play of this account.',
    input: { author, track },
    kind: 'add',
    run: ({ author: a, track: t }) => api.get(trackPath(a, t, 'cast')),
  });

  tool('post_comment', {
    title: 'Comment',
    description: 'Posts a public comment on a track, optionally at a position in seconds or as a reply to another comment.',
    input: {
      author,
      track,
      comment: z.string().min(1),
      position: z.number().int().min(0).optional().describe('Position in the track in seconds'),
      parent: z.number().int().optional().describe('Id of the comment this replies to'),
    },
    kind: 'add',
    run: ({ author: a, track: t, comment, position, parent }) =>
      api.post(trackPath(a, t, 'comment'), { comment, comment_position: position, parent }),
  });

  tool('delete_comment', {
    title: 'Delete comment',
    description: 'Deletes a comment of the account (or any comment on an own track).',
    input: { author, track, comment_id: z.number().int() },
    kind: 'destructive',
    run: ({ author: a, track: t, comment_id }) => api.post(trackPath(a, t, 'comment'), { action: 'delete', id: comment_id }),
  });

  tool('post_reaction', {
    title: 'Reaction',
    description: 'Posts an emoji reaction at a position of a track. Valid reaction ids are in get_track_part part=reactions.',
    input: {
      author,
      track,
      reaction: z.number().int().min(0),
      position: z.number().int().min(0).describe('Position in the track in seconds'),
    },
    kind: 'add',
    run: ({ author: a, track: t, reaction, position }) => api.post(trackPath(a, t, 'reaction'), { reaction, reaction_position: position }),
  });

  tool('streaming_quality', {
    title: 'Streaming quality',
    description:
      'Streaming quality of an own track. Without value: the current state. value=best queues the highest quality of the file ' +
      'type; a number queues that bitrate (999 = original MP3, 1000 = lossless). The change is transcoded in the background.',
    input: { author, track, value: z.enum(['best', '96', '128', '192', '256', '320', '999', '1000']).optional() },
    kind: 'write',
    run: ({ author: a, track: t, value }) => api.get(trackPath(a, t, 'bitrate'), { value }),
  });

  tool('copy_track_image', {
    title: 'Copy track image',
    description: 'Copies the cover or background image of another own track onto this own track.',
    input: { author, track, from_track_id: z.number().int(), kind: z.enum(['cover', 'background']) },
    kind: 'write',
    run: ({ author: a, track: t, from_track_id, kind }) => api.get(trackPath(a, t, 'copyimage'), { from: from_track_id, kind }),
  });

  tool('upload_track', {
    title: 'Upload track',
    description:
      'Uploads a local audio file (mp3, wav, flac, aac, m4a, ogg, aif/aiff, wma, opus) as a new track of the account, ' +
      'with optional metadata and cover. The track stays private unless private=false - publish only when the user asked for it. ' +
      'Only upload files the user named.',
    input: {
      file_path: z.string().min(1).describe('Absolute path of the audio file'),
      title: z.string().optional(),
      description: z.string().optional(),
      genre: z.string().optional().describe('Genre slug or label, e.g. "techno"'),
      tags: z.string().optional().describe('Comma-separated'),
      tracklist: z.string().optional().describe('One chapter per line: [HH:MM:SS] Artist - Title'),
      private: z.boolean().default(true).describe('false publishes the track at once'),
      downloadable: flag,
      comments: flag.describe('Allow comments'),
      release_at: iso,
      unpublish_at: iso,
      cover_path: z.string().optional().describe('Absolute path of a JPG or PNG cover, max 10 MB'),
    },
    kind: 'write',
    run: ({ file_path, cover_path, private: priv, downloadable, comments, ...meta }) =>
      api.postFiles(
        '/upload_api.php',
        { ...meta, private: bit(priv), downloadable: bit(downloadable), comments: bit(comments) },
        { file: { path: file_path, kind: 'audio' }, ...(cover_path ? { image: { path: cover_path, kind: 'image' as const } } : {}) },
      ),
  });

  tool('edit_track', {
    title: 'Edit track',
    description:
      'Changes settings of an own track - everything the edit page can change, by the same rules. Only the fields given change; ' +
      'options the account cannot use (plan, fan programme, transcript) keep their value. private=false publishes the track and ' +
      'notifies followers. answer.waiting=true: the title matched a copyright keyword and the sound waits for approval.',
    input: {
      track_id: z.number().int(),
      title: z.string().max(200).optional().describe('The link stays - use permalink to change it'),
      permalink: z.string().optional().describe('Last part of the track link; the old link keeps redirecting'),
      description: z.string().optional().describe('Markdown'),
      genre: z.string().optional().describe('Genre slug or label (list_genres)'),
      genre_own: z.string().optional(),
      tags: z.array(z.string()).optional(),
      subgenres: z.array(z.string()).optional(),
      tracklist: z.string().optional().describe('One chapter per line: [HH:MM:SS] Artist - Title'),
      download_filename: z.string().optional(),
      private: flag,
      hidden: flag.describe('Hide from the profile and the lists'),
      comments: flag,
      stats_hidden: flag,
      podcast: flag.describe('Include in the podcast feed'),
      release_at: iso.describe('Scheduled release, future - only for a private sound never published; empty clears'),
      unpublish_at: iso.describe('Scheduled unpublish, future - only for a public sound; empty clears'),
      release_date: z.string().optional().describe('Original release date YYYY-MM-DD'),
      version_type: z.enum(['', 'Original', 'Remix', 'Mix', 'Bootleg', 'Remastered', 'WIP', 'Live', 'DJ-Set', 'Podcast', 'Unplugged', 'Cover']).optional(),
      version: z.string().max(80).optional().describe('e.g. Extended Mix'),
      bpm: z.number().int().min(0).max(999).optional(),
      musical_key: z.string().max(12).optional().describe('Musical key, e.g. Abm'),
      license: z.enum(['', 'all', 'no', 'Attribution', 'Noncommercial', 'NoDerivativeWorks', 'NoDerivativeWorksShareAlike', 'NoncommercialNoDerivatives', 'NoncommercialShareAlike']).optional(),
      location: z.string().optional(),
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      buy_link: z.string().optional(),
      buy_link_title: z.string().optional(),
      show_analysis: flag.describe('Show the detected tempo and key'),
      ai_generated: flag,
      artists: z.array(z.number().int()).optional().describe('User ids of the artists on the sound - every newly tagged artist gets an e-mail; only tag artists the user named'),
      downloadable: flag,
      download_gate: z.enum(['all', 'reshare', 'follow']).optional().describe('Who may download'),
      download_secret: z.string().optional(),
      fans_only_play: flag,
      fans_only_download: flag,
      fans_only_tracklist: flag,
      template: z.union([z.literal(0), z.literal(3), z.literal(4)]).optional().describe('Player theme'),
      waveform_color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
      waveform_highlight: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
      waveform_style: z.union([z.literal(1), z.literal(2)]).optional(),
      block_size: z.number().int().min(0).optional(),
      block_space: z.number().int().min(0).optional(),
      youtube_video: z.string().optional().describe('YouTube link behind the player'),
      youtube_start: z.number().int().min(0).optional().describe('Seconds'),
      bitrate: z.enum(['96', '128', '192', '256', '320', '999', '1000']).optional().describe('Before the first encoding only; later streaming_quality'),
      auto_tracklist: flag,
      related: flag.describe('Show related sounds'),
      more_by: z.array(z.number().int()).optional(),
      embed_domains: z.array(z.string()).optional().describe('Sites allowed to embed the sound'),
      subtitles: flag,
      featured: flag.describe('Switch a bought feature on or off'),
    },
    kind: 'write',
    run: (args) =>
      api.post(
        '/track_edit_api.php',
        Object.fromEntries(
          Object.entries(args).map(([name, value]) => [name, typeof value === 'boolean' ? bit(value) : Array.isArray(value) ? value.join(',') : value]),
        ) as Params,
        {},
        XHR_BASE,
      ),
  });

  tool('delete_track', {
    title: 'Delete track',
    description: 'Deletes an own track. Ask the user for confirmation first.',
    input: { track_id: z.number().int() },
    kind: 'destructive',
    run: ({ track_id }) => api.post('/track_edit_api.php', { track_id, action: 'delete' }, {}, XHR_BASE),
  });

  tool('set_track_cover', {
    title: 'Set track cover',
    description: 'Sets or replaces the cover of an own track from a local JPG or PNG (max 10 MB).',
    input: { track_id: z.number().int(), image_path: z.string().min(1).describe('Absolute path of the image') },
    kind: 'write',
    run: ({ track_id, image_path }) => api.postFiles('/track_image_api.php', { track_id }, { image: { path: image_path, kind: 'image' } }),
  });

  tool('remove_track_cover', {
    title: 'Remove track cover',
    description: 'Removes the cover of an own track.',
    input: { track_id: z.number().int() },
    kind: 'destructive',
    run: ({ track_id }) => api.post('/track_image_api.php', { track_id, action: 'delete' }, {}, XHR_BASE),
  });

  // Users

  tool('get_user', {
    title: 'User',
    description: 'A profile, or one of its lists: tracks, likes, reposts, following, followers, playlists, connected, badges.',
    input: {
      author,
      list: z.enum(['tracks', 'likes', 'reposts', 'following', 'followers', 'playlists', 'connected', 'badges']).optional(),
      page,
      count: count(50, 10),
    },
    kind: 'read',
    run: ({ author: a, list, ...rest }) => api.get(`/${authorSegment(a)}/`, { type: list, ...rest }),
  });

  tool('toggle_follow', {
    title: 'Follow / unfollow',
    description: 'Follows a user, or unfollows when the account already follows them. User id from get_user.',
    input: { user_id: z.number().int() },
    kind: 'write',
    run: ({ user_id }) => api.post('/user_ajax_function.php', { userid: user_id, action: 'follow' }),
  });

  tool('badge_settings', {
    title: 'Badge settings',
    description: 'Shows badges on the profile (badges_public) and the weekly mail about new badges (email_badges). Only the fields given change.',
    input: { badges_public: flag, email_badges: flag },
    kind: 'write',
    run: ({ badges_public, email_badges }) =>
      api.post('/user_ajax_options.php', { action: 'badges', badges_public: bit(badges_public), email_badges: bit(email_badges) }),
  });

  tool('get_fan_subscriptions', {
    title: 'Fan subscriptions',
    description: 'subscribed: the fan subscriptions the account pays. subscribers: the account\'s fans with statistics.',
    input: { type: z.enum(['subscribed', 'subscribers']).default('subscribed'), page, count: count(100, 20) },
    kind: 'read',
    run: (args) => api.get('/fan_subscriptions.php', args),
  });

  // Sets (playlists)

  tool('list_my_sets', {
    title: 'My sets',
    description: 'Sets (playlists) of the account.',
    input: { page, count: count(50, 20), exclude_track_id: z.number().int().optional().describe('Leave out sets that contain this track') },
    kind: 'read',
    run: ({ exclude_track_id, ...rest }) => api.get('/app/collections/', { ...rest, exclude_song_id: exclude_track_id }),
  });

  tool('get_set', {
    title: 'Set',
    description: 'All tracks of a set.',
    input: { permalink: z.string().min(1).describe('Set permalink from list_my_sets, e.g. "199387-7"') },
    kind: 'read',
    run: ({ permalink }) => api.get(`/set/${segment(permalink)}/`),
  });

  tool('add_to_set', {
    title: 'Add to set',
    description: 'Adds a track to an existing set (set_id), or creates a new set with that name (new_set_name).',
    input: { track_id: z.number().int(), set_id: z.number().int().optional(), new_set_name: z.string().optional() },
    kind: 'add',
    run: async ({ track_id, set_id, new_set_name }) => {
      if (!set_id && !new_set_name) {
        throw new ApiError('Give set_id or new_set_name.', 400);
      }
      return api.post('/set_ajax_add.php', { action: 'add', track_id, set: set_id, new_set: set_id ? undefined : new_set_name });
    },
  });

  tool('edit_set', {
    title: 'Edit set',
    description:
      'Changes a set of the account by the rules of its edit page - only the fields given change. Owner and moderators; ' +
      'privat only the owner.',
    input: {
      set_id: z.number().int(),
      name: z.string().min(1).max(120).optional(),
      permalink: z.string().min(3).optional().describe('Last part of the set link'),
      description: z.string().optional(),
      genre: z.string().optional().describe('Genre slug (list_genres)'),
      private: flag,
      open: flag.describe('Others may add sounds'),
      sort: z.enum(['manual', 'alpha', 'random', 'plays']).optional(),
    },
    kind: 'write',
    run: ({ set_id, permalink, genre, private: priv, open, sort, ...rest }) =>
      api.post('/set_ajax_edit.php', {
        ...rest,
        action: 'save',
        id: set_id,
        name_url: permalink,
        category: genre,
        privat: bit(priv),
        public: bit(open),
        sort_config: sort ? { manual: 1, alpha: 2, random: 3, plays: 4 }[sort] : undefined,
      }),
  });

  tool('edit_profile', {
    title: 'Edit profile',
    description:
      'Changes the profile of the account by the rules of its settings page - only the fields given change. Options of a plan the ' +
      'account does not have keep their value. E-mail, password, profile address, payouts, podcast and fan subscriptions change ' +
      'only on the website; the answer lists such fields under ignored.',
    input: {
      name: z.string().min(1).max(100).optional(),
      caption: z.string().max(100).optional().describe('Crew, label or subline below the name'),
      description: z.string().optional().describe('Profile text (Markdown)'),
      track_footer: z.string().optional().describe('Text shown below every own sound'),
      genres: z.array(z.string()).min(1).max(4).optional().describe('Genre slugs (list_genres), the first is the main genre'),
      links: z
        .array(z.object({ url: z.string().min(1), title: z.string().optional() }))
        .max(30)
        .optional()
        .describe('Replaces all links of the profile; [] removes them'),
      facebook: z.string().optional(),
      twitter: z.string().optional(),
      support_url: z.string().optional().describe('Donation or support link'),
      place: z.string().optional(),
      is_group: flag.describe('A group, organization, label or band'),
      featured_track_id: z.number().int().min(0).optional().describe('Own public sound shown first, 0 = none'),
      hide_followers: flag.describe('Premium'),
      hide_following: flag.describe('Premium'),
      default_private: flag.describe('New uploads start private (Pro and Premium)'),
      default_comments: flag.describe('New uploads allow comments (Pro and Premium)'),
      default_download: flag.describe('New uploads are downloadable'),
      default_hide_statistics: flag.describe('New uploads hide their statistics'),
      default_bitrate: z.union([z.literal(96), z.literal(128), z.literal(192), z.literal(256), z.literal(320)]).optional().describe('Above 192 Premium'),
      use_profile_as_cover: flag.describe('Profile picture as cover of uploads without one'),
      highlight: z.string().regex(/^[0-9a-fA-F]{6}$/).optional().describe('Hex colour without # (Premium)'),
    },
    kind: 'write',
    run: ({ name, caption, track_footer, genres, links, facebook, twitter, support_url, place, is_group, featured_track_id, ...rest }) => {
      const params: Params = {
        action: 'profile',
        alias: name,
        sub: caption,
        description: rest.description,
        track_subdescription: track_footer,
        url_facebook: facebook,
        url_twitter: twitter,
        url_support: support_url,
        geo: place,
        gender: bit(is_group),
        featured_track: featured_track_id,
        hide_followers: bit(rest.hide_followers),
        hide_following: bit(rest.hide_following),
        default_private: bit(rest.default_private),
        default_comments: bit(rest.default_comments),
        default_download: bit(rest.default_download),
        default_hide_statistics: bit(rest.default_hide_statistics),
        default_bitrate: rest.default_bitrate,
        use_profile_as_cover: bit(rest.use_profile_as_cover),
        highlight: rest.highlight?.toLowerCase(),
      };
      // The genres given replace all four slots - fewer genres empty the rest
      if (genres) {
        for (let index = 0; index < 4; index++) {
          params[index === 0 ? 'category' : `category${index + 1}`] = genres[index] ?? '';
        }
      }
      if (links) {
        params.gp_urls = links.map((link) => link.url.replace(/\s+/g, '')).join('\n');
        params.gp_urls_names = links.map((link) => (link.title ?? '').replace(/\s+/g, ' ').trim()).join('\n');
      }
      return api.post('/user_ajax_edit.php', params);
    },
  });

  tool('remove_from_set', {
    title: 'Remove from set',
    description: 'Removes a track from a set of the account.',
    input: { set_id: z.number().int(), track_id: z.number().int() },
    kind: 'destructive',
    run: async ({ set_id, track_id }) => {
      // reply=status: {ok:true} only when the track was in the set and the account may remove it - without it a refusal is an empty 200
      const answer = (await api.post('/set_ajax_edit.php', { action: 'deleteentry', set_id, id: track_id, reply: 'status' })) as { ok?: boolean } | null;
      if (answer?.ok !== true) {
        throw new ApiError('Not removed: the track is not in this set, or the account may not remove it.', 400, 'not_removed');
      }
      return { success: true, set_id, track_id };
    },
  });

  tool('delete_set', {
    title: 'Delete set',
    description: 'Deletes a set of the account (the tracks stay). Ask the user for confirmation first.',
    input: { set_id: z.number().int() },
    kind: 'destructive',
    run: ({ set_id }) => api.post('/set_ajax_edit.php', { action: 'delete', set: set_id }),
  });

  // Groups

  tool('list_groups', {
    title: 'Groups',
    description: 'Groups of a genre, groups a user owns (user_groups) or groups a user joined (joined; default: this account).',
    input: {
      type: z.enum(['genre', 'user_groups', 'joined']),
      genre: z.string().optional().describe('Genre slug for type=genre'),
      user_id: z.number().int().optional(),
      page,
      count: count(50, 20),
    },
    kind: 'read',
    run: (args) => api.get('/groups/', args),
  });

  tool('get_group', {
    title: 'Group',
    description: 'A group: info (metadata and own permissions), tracks (paged), members (owner first).',
    input: { group_id: z.number().int(), part: z.enum(['info', 'tracks', 'members']).default('info'), page, count: count(50, 20) },
    kind: 'read',
    run: ({ group_id, part, ...rest }) => api.get(`/group/${segment(group_id)}/${part === 'tracks' ? '' : part + '/'}`, part === 'info' ? {} : rest),
  });

  tool('create_group', {
    title: 'Create group',
    description: 'Creates a group owned by the account.',
    input: {
      name: z.string().min(1),
      description: z.string().optional(),
      genre: z.string().optional().describe('Genre slug'),
      private: flag.describe('Closed group: only moderators add tracks'),
      sort: z.enum(['manual', 'alpha', 'random', 'plays']).optional(),
    },
    kind: 'add',
    run: ({ name, description, genre, private: priv, sort }) =>
      api.post(
        '/groups/',
        { name, description, category: genre, privat: bit(priv), sort_config: sort ? { manual: 1, alpha: 2, random: 3, plays: 4 }[sort] : undefined },
        { type: 'create' },
      ),
  });

  tool('edit_group', {
    title: 'Edit group',
    description:
      'Changes a group by the rules of its edit page - only the fields given change. Owner and editors; private only the owner. ' +
      'member_notify=true mails the members about every new sound - only switch it on when the user asked.',
    input: {
      group_id: z.number().int(),
      name: z.string().min(1).max(120).optional(),
      permalink: z.string().min(3).optional(),
      description: z.string().optional(),
      genre: z.string().optional(),
      private: flag,
      open: flag.describe('Members may add sounds'),
      approve: flag.describe('New sounds wait for approval'),
      notify: flag.describe('Mail the owner about new sounds'),
      member_notify: flag.describe('Mail the members about new sounds'),
      sort: z.enum(['manual', 'alpha', 'random', 'plays']).optional(),
      editors: z.array(z.number().int()).optional().describe('User ids of the editors - replaces the list; owner only'),
    },
    kind: 'write',
    run: ({ group_id, permalink, genre, private: priv, open, approve, notify, member_notify, sort, editors, ...rest }) =>
      api.post(`/group/${segment(group_id)}/edit/`, {
        ...rest,
        name_url: permalink,
        category: genre,
        privat: bit(priv),
        open: bit(open),
        approve: bit(approve),
        notify: bit(notify),
        member_notify: bit(member_notify),
        sort_config: sort ? { manual: 1, alpha: 2, random: 3, plays: 4 }[sort] : undefined,
        editors: editors ? editors.join(',') : undefined,
      }),
  });

  tool('join_group', {
    title: 'Join / leave group',
    description: 'Joins a group (join=true) or leaves it (join=false). The owner cannot leave.',
    input: { group_id: z.number().int(), join: z.boolean() },
    kind: 'write',
    run: ({ group_id, join }) => api.post(`/group/${segment(group_id)}/${join ? 'join' : 'leave'}/`),
  });

  tool('group_track', {
    title: 'Add / remove group track',
    description: 'Adds a track to a group (add=true) or removes it (add=false). Owner, editors and the sound\'s author are published at once; others wait while the group asks for approval. Adding notifies the members and may mail the owner.',
    input: { group_id: z.number().int(), track_id: z.number().int(), add: z.boolean() },
    kind: 'write',
    run: ({ group_id, track_id, add }) => api.post(`/group/${segment(group_id)}/${add ? 'add' : 'remove'}/`, { track_id }),
  });

  tool('group_member_role', {
    title: 'Group member role',
    description: 'Owner only: makes a member an editor or a plain member, or blocks them (use group_block to lift a block).',
    input: { group_id: z.number().int(), user_id: z.number().int(), role: z.enum(['member', 'editor', 'blocked']) },
    kind: 'write',
    run: ({ group_id, user_id, role }) =>
      api.post(`/group/${segment(group_id)}/permissions/`, { user_id, rights: { member: 0, editor: 5, blocked: -1 }[role] }),
  });

  tool('group_block', {
    title: 'Block / unblock in a group',
    description: 'Owner and editors: blocks a user from a group (they leave it and cannot join or add) or lifts the block.',
    input: { group_id: z.number().int(), user_id: z.number().int(), block: z.boolean() },
    kind: 'write',
    run: ({ group_id, user_id, block }) => api.post(`/group/${segment(group_id)}/${block ? 'block' : 'unblock'}/`, { user_id }),
  });

  tool('group_approve', {
    title: 'Approve a sound in a group',
    description: 'Owner and editors: publishes a sound that waits for approval; the members are told about it.',
    input: { group_id: z.number().int(), track_id: z.number().int() },
    kind: 'add',
    run: ({ group_id, track_id }) => api.post(`/group/${segment(group_id)}/approve/`, { track_id }),
  });

  tool('delete_group', {
    title: 'Delete group',
    description: 'Owner only: deletes a group. Ask the user for confirmation first.',
    input: { group_id: z.number().int() },
    kind: 'destructive',
    run: ({ group_id }) => api.post(`/group/${segment(group_id)}/delete/`),
  });

  // Messages

  tool('list_conversations', {
    title: 'Conversations',
    description: 'Direct-message conversations of the account, most recent first, with unread counts.',
    input: {},
    kind: 'read',
    run: () => api.get('/messages/'),
  });

  tool('read_conversation', {
    title: 'Read conversation',
    description: 'Messages with one user, oldest first. Leaves them unread unless mark_read=true.',
    input: {
      user_id: z.number().int(),
      limit: count(200, 50),
      before: z.number().int().optional().describe('Message id - returns the page of older messages'),
      mark_read: z.boolean().default(false),
    },
    kind: 'add',
    run: ({ user_id, mark_read, ...rest }) => api.get(`/messages/${segment(user_id)}/`, { ...rest, mark_read: bit(mark_read) }),
  });

  tool('poll_messages', {
    title: 'New messages',
    description: 'Incoming messages with an id above since (max 100). Without since only the current cursor comes back. Marks nothing as read.',
    input: { since: z.number().int().min(0).optional() },
    kind: 'read',
    run: (args) => api.get('/messages/poll/', args),
  });

  tool('send_message', {
    title: 'Send message',
    description: 'Sends a direct message (max 2000 characters) to a user. Only send what the user asked to send.',
    input: { user_id: z.number().int(), message: z.string().min(1).max(2000) },
    kind: 'add',
    run: ({ user_id, message }) => api.post(`/messages/${segment(user_id)}/`, { message }),
  });

  tool('delete_conversation', {
    title: 'Delete conversation',
    description: 'Deletes a whole conversation for both sides. Ask the user for confirmation first.',
    input: { user_id: z.number().int() },
    kind: 'destructive',
    run: ({ user_id }) => api.post(`/messages/${segment(user_id)}/delete/`),
  });
}
