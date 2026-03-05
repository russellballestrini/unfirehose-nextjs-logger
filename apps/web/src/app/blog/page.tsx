'use client';

import { useState, useRef, useEffect } from 'react';
import useSWR from 'swr';
import { PageContext } from '@unfirehose/ui/PageContext';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// jsonblog.org post schema
interface BlogPost {
  id?: number;
  post_uuid?: string;
  title: string;
  description: string | null;
  source: string | null;
  content: string | null;
  url: string | null;
  created_at?: string;
  updated_at?: string;
  // jsonblog external format uses camelCase
  createdAt?: string;
  updatedAt?: string;
}

// jsonblog.org schema
interface BlogJson {
  site?: { title?: string; description?: string };
  basics?: {
    name?: string;
    label?: string;
    image?: string;
    email?: string;
    url?: string;
    summary?: string;
    location?: { city?: string; region?: string; countryCode?: string };
    profiles?: Array<{ network?: string; username?: string; url?: string }>;
  };
  posts?: BlogPost[];
  meta?: { canonical?: string; version?: string; lastModified?: string };
}

// JSON Resume (superset of jsonblog basics)
interface JsonResume {
  basics?: BlogJson['basics'] & {
    phone?: string;
  };
  work?: Array<{
    name?: string;
    position?: string;
    startDate?: string;
    endDate?: string;
    summary?: string;
    url?: string;
  }>;
  skills?: Array<{ name?: string; keywords?: string[] }>;
}

function timeAgo(dateStr: string | undefined | null): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export default function BlogPage() {
  const { data: localPosts, mutate } = useSWR<BlogPost[]>('/api/blog', fetcher, { refreshInterval: 10000 });
  const { data: resume } = useSWR<JsonResume>('/api/blog/resume', fetcher);
  const { data: settings } = useSWR<Record<string, string>>('/api/settings', fetcher);

  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [source, setSource] = useState('');
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [feedUrl, setFeedUrl] = useState('');
  const [externalBlog, setExternalBlog] = useState<BlogJson | null>(null);
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [tab, setTab] = useState<'local' | 'feed'>('local');
  const titleRef = useRef<HTMLInputElement>(null);

  // Resolve profile from settings → resume → defaults
  const handle = settings?.['unfirehose_handle'] || resume?.basics?.name?.toLowerCase().replace(/\s+/g, '') || 'anon';
  const displayName = settings?.['unfirehose_display_name'] || resume?.basics?.name || handle;
  const bio = settings?.['unfirehose_bio'] || resume?.basics?.summary || '';
  const basics = resume?.basics;

  const posts = localPosts ?? [];

  // Fetch external jsonblog feed
  const loadFeed = async (url: string) => {
    if (!url.trim()) return;
    setLoadingFeed(true);
    try {
      const res = await fetch(url.trim());
      const data: BlogJson = await res.json();
      setExternalBlog(data);
      setTab('feed');
    } catch {
      setExternalBlog(null);
    }
    setLoadingFeed(false);
  };

  // Source content fetcher for posts with source URIs
  const [sourceContents, setSourceContents] = useState<Record<string, string>>({});
  const fetchSource = async (sourceUrl: string) => {
    if (sourceContents[sourceUrl]) return;
    try {
      const res = await fetch(sourceUrl);
      const text = await res.text();
      setSourceContents((prev) => ({ ...prev, [sourceUrl]: text }));
    } catch {
      setSourceContents((prev) => ({ ...prev, [sourceUrl]: '[failed to load]' }));
    }
  };

  const submit = async () => {
    if (!title.trim()) return;
    setSending(true);
    await fetch('/api/blog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title.trim(),
        description: description.trim() || undefined,
        source: source.trim() || undefined,
        content: content.trim() || undefined,
      }),
    });
    setTitle('');
    setDescription('');
    setSource('');
    setContent('');
    setComposing(false);
    setSending(false);
    mutate();
  };

  const handleDelete = async (id: number) => {
    await fetch('/api/blog', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    mutate();
  };

  // Determine which posts to show
  const feedPosts = externalBlog?.posts ?? [];
  const activePosts = tab === 'feed' ? feedPosts : posts;
  const activeBasics = tab === 'feed' ? externalBlog?.basics : basics;
  const activeSite = tab === 'feed' ? externalBlog?.site : undefined;

  return (
    <div className="max-w-2xl space-y-4">
      <PageContext
        pageType="blog"
        summary={`Blog. ${posts.length} local posts. Handle: @${handle}. jsonblog format.`}
        metrics={{ posts: posts.length, handle, has_resume: basics ? 1 : 0 }}
      />

      {/* Profile Card */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <div className="flex items-start gap-4">
          {activeBasics?.image ? (
            <img
              src={activeBasics.image}
              alt={activeBasics.name ?? ''}
              className="w-14 h-14 rounded-full border-2 border-[var(--color-accent)] shrink-0 object-cover"
            />
          ) : (
            <div className="w-14 h-14 rounded-full bg-[var(--color-accent)]/20 border-2 border-[var(--color-accent)] flex items-center justify-center text-xl font-bold text-[var(--color-accent)] shrink-0">
              {(activeBasics?.name ?? displayName).charAt(0).toUpperCase()}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="text-base font-bold">{activeBasics?.name ?? displayName}</span>
              {activeBasics?.label && (
                <span className="text-base text-[var(--color-muted)]">{activeBasics.label}</span>
              )}
            </div>
            {(activeBasics?.summary ?? bio) && (
              <p className="text-base text-[var(--color-muted)] mt-1">
                {activeBasics?.summary ?? bio}
              </p>
            )}
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-2">
              {activeBasics?.location && (
                <span className="text-base text-[var(--color-muted)]">
                  {[activeBasics.location.city, activeBasics.location.region].filter(Boolean).join(', ')}
                </span>
              )}
              {activeBasics?.url && (
                <a href={activeBasics.url} target="_blank" rel="noopener noreferrer" className="text-base text-[var(--color-accent)] hover:underline">
                  {activeBasics.url.replace(/https?:\/\//, '')}
                </a>
              )}
            </div>
            {/* Social profiles */}
            {activeBasics?.profiles && activeBasics.profiles.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {activeBasics.profiles.map((p, i) => (
                  <a
                    key={i}
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-base px-2 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:border-[var(--color-accent)] transition-colors"
                  >
                    {p.network}
                  </a>
                ))}
              </div>
            )}
            {/* Skills from resume */}
            {resume?.skills && resume.skills.length > 0 && tab === 'local' && (
              <div className="flex flex-wrap gap-1 mt-2">
                {resume.skills.slice(0, 6).map((s, i) => (
                  <span key={i} className="text-base px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-muted)]">
                    {s.name}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="text-right shrink-0">
            <div className="text-lg font-bold text-[var(--color-accent)]">{activePosts.length}</div>
            <div className="text-base text-[var(--color-muted)]">posts</div>
          </div>
        </div>

        {/* Work timeline from resume */}
        {resume?.work && resume.work.length > 0 && tab === 'local' && (
          <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {resume.work.slice(0, 3).map((w, i) => (
                <span key={i} className="text-base text-[var(--color-muted)]">
                  <span className="text-[var(--color-foreground)]">{w.position}</span> @ {w.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Feed site info */}
        {activeSite && tab === 'feed' && (
          <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
            {activeSite.title && <div className="text-base font-bold">{activeSite.title}</div>}
            {activeSite.description && <div className="text-base text-[var(--color-muted)]">{activeSite.description}</div>}
          </div>
        )}
      </div>

      {/* Feed loader */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-3">
        <div className="flex gap-2">
          <input
            type="url"
            value={feedUrl}
            onChange={(e) => setFeedUrl(e.target.value)}
            placeholder="Load jsonblog feed URL..."
            className="flex-1 bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono"
            onKeyDown={(e) => { if (e.key === 'Enter') loadFeed(feedUrl); }}
          />
          <button
            onClick={() => loadFeed(feedUrl)}
            disabled={!feedUrl.trim() || loadingFeed}
            className="text-base font-bold px-3 py-1.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-muted)] hover:text-[var(--color-foreground)] disabled:opacity-30 transition-colors"
          >
            {loadingFeed ? '...' : 'Load'}
          </button>
        </div>
      </div>

      {/* Tabs: Local / Feed */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setTab('local')}
          className={`text-base px-3 py-1 rounded transition-colors ${
            tab === 'local' ? 'text-[var(--color-accent)] font-bold bg-[var(--color-accent)]/10' : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
          }`}
        >
          My Posts ({posts.length})
        </button>
        {externalBlog && (
          <button
            onClick={() => setTab('feed')}
            className={`text-base px-3 py-1 rounded transition-colors ${
              tab === 'feed' ? 'text-[var(--color-accent)] font-bold bg-[var(--color-accent)]/10' : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
            }`}
          >
            {externalBlog.basics?.name ?? 'Feed'} ({feedPosts.length})
          </button>
        )}
        <div className="flex-1" />
        <a
          href="/api/blog/blah.json"
          target="_blank"
          rel="noopener noreferrer"
          className="text-base text-[var(--color-muted)] hover:text-[var(--color-accent)] transition-colors font-mono"
        >
          blah.json
        </a>
      </div>

      {/* Compose (local tab only) */}
      {tab === 'local' && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-3">
          {!composing ? (
            <button
              onClick={() => {
                setComposing(true);
                setTimeout(() => titleRef.current?.focus(), 50);
              }}
              className="w-full text-left text-base text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors py-1"
            >
              New post...
            </button>
          ) : (
            <div className="space-y-3">
              <input
                ref={titleRef}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Post title"
                className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base font-bold"
              />
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Short description (optional)"
                className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base text-[var(--color-muted)]"
              />
              <input
                type="url"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="Source URI — gist, dropbox, any public URL to markdown (optional)"
                className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono text-[var(--color-muted)]"
              />
              {!source && (
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Or write content directly..."
                  rows={6}
                  className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base resize-none"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.metaKey) submit();
                    if (e.key === 'Escape') setComposing(false);
                  }}
                />
              )}
              <div className="flex items-center justify-between">
                <span className="text-base text-[var(--color-muted)]">
                  {source ? 'source URI set' : content.length > 0 ? `${content.length} chars` : 'cmd+enter to post'}
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setComposing(false)}
                    className="text-base text-[var(--color-muted)] hover:text-[var(--color-foreground)] px-3 py-1.5"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={submit}
                    disabled={!title.trim() || sending}
                    className="text-base font-bold bg-[var(--color-accent)] text-black px-4 py-1.5 rounded hover:opacity-90 transition-opacity disabled:opacity-30"
                  >
                    {sending ? 'Posting...' : 'Post'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Posts timeline */}
      {activePosts.length === 0 ? (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-8 text-center">
          <div className="text-2xl mb-2" style={{ color: 'var(--color-accent)' }}>{'>'}_</div>
          <p className="text-base text-[var(--color-muted)]">
            {tab === 'local' ? 'No posts yet. Write your first post.' : 'No posts in this feed.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {activePosts.map((post, i) => (
            <PostCard
              key={post.id ?? i}
              post={post}
              authorName={activeBasics?.name ?? displayName}
              isLocal={tab === 'local'}
              onDelete={post.id ? () => handleDelete(post.id!) : undefined}
              sourceContents={sourceContents}
              onFetchSource={fetchSource}
            />
          ))}
        </div>
      )}

      {/* Work history from resume */}
      {resume?.work && resume.work.length > 0 && tab === 'local' && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold text-[var(--color-muted)] mb-3">Work</h3>
          <div className="space-y-2">
            {resume.work.map((w, i) => (
              <div key={i} className="flex items-baseline gap-3">
                <span className="text-base text-[var(--color-muted)] font-mono shrink-0 w-20">
                  {w.startDate?.slice(0, 4) ?? '?'}–{w.endDate?.slice(0, 4) ?? 'now'}
                </span>
                <div className="min-w-0">
                  <span className="text-base text-[var(--color-foreground)]">{w.position}</span>
                  {w.name && (
                    <span className="text-base text-[var(--color-muted)]"> @ {w.name}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PostCard({
  post,
  authorName,
  isLocal,
  onDelete,
  sourceContents,
  onFetchSource,
}: {
  post: BlogPost;
  authorName: string;
  isLocal: boolean;
  onDelete?: () => void;
  sourceContents: Record<string, string>;
  onFetchSource: (url: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const date = post.created_at ?? post.createdAt;
  const hasSource = !!post.source;
  const loadedSource = post.source ? sourceContents[post.source] : null;
  const displayContent = post.content ?? loadedSource ?? post.description ?? '';
  const isLong = displayContent.length > 280;

  // Auto-fetch source content when expanded
  useEffect(() => {
    if (expanded && post.source && !sourceContents[post.source]) {
      onFetchSource(post.source);
    }
  }, [expanded, post.source, sourceContents, onFetchSource]);

  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 hover:border-[var(--color-muted)] transition-colors">
      {/* Title */}
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-bold">{post.title}</h3>
        <span className="text-base text-[var(--color-muted)] shrink-0">{timeAgo(date)}</span>
      </div>

      {/* Description */}
      {post.description && (
        <p className="text-base text-[var(--color-muted)] mt-1">{post.description}</p>
      )}

      {/* Content */}
      {displayContent && (
        <div className="mt-2">
          <div className="text-base text-[var(--color-foreground)] whitespace-pre-wrap break-words">
            {displayContent}
          </div>
          {isLong && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-base text-[var(--color-accent)] mt-1 hover:underline"
            >
              {expanded ? 'Show less' : 'Read more'}
            </button>
          )}
        </div>
      )}

      {/* Source link */}
      {hasSource && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="text-base text-[var(--color-accent)] mt-2 hover:underline block"
        >
          Load from source
        </button>
      )}
      {hasSource && expanded && (
        <a
          href={post.source!}
          target="_blank"
          rel="noopener noreferrer"
          className="text-base text-[var(--color-muted)] font-mono mt-1 hover:text-[var(--color-accent)] block break-all"
        >
          {post.source}
        </a>
      )}

      {/* Footer */}
      <div className="flex items-center gap-4 mt-3 pt-2 border-t border-[var(--color-border)]">
        <span className="text-base text-[var(--color-muted)]">{authorName}</span>
        {date && (
          <span className="text-base text-[var(--color-muted)] font-mono">
            {new Date(date).toLocaleDateString()}
          </span>
        )}
        {isLocal && onDelete && (
          <button
            onClick={onDelete}
            className="text-base text-[var(--color-muted)] hover:text-[var(--color-error)] transition-colors ml-auto"
          >
            delete
          </button>
        )}
      </div>
    </div>
  );
}
