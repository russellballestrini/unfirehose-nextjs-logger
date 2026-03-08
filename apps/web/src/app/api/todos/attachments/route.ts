import { NextRequest, NextResponse } from 'next/server';
import { getDb, UNFIREHOSE_DIR } from '@unturf/unfirehose/db/schema';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import path from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const ATTACHMENTS_DIR = path.join(UNFIREHOSE_DIR, 'attachments');

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const todoId = formData.get('todoId');
    if (!todoId) {
      return NextResponse.json({ error: 'todoId required' }, { status: 400 });
    }

    const files = formData.getAll('files') as File[];
    if (files.length === 0) {
      return NextResponse.json({ error: 'no files provided' }, { status: 400 });
    }

    // Validate sizes before processing
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { error: `file "${file.name}" exceeds 10MB limit (${file.size} bytes)` },
          { status: 400 }
        );
      }
    }

    mkdirSync(ATTACHMENTS_DIR, { recursive: true });

    const db = getDb();
    const now = new Date().toISOString();
    const attachments: any[] = [];

    const insert = db.prepare(`
      INSERT INTO todo_attachments (todo_id, filename, mime_type, size_bytes, hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const hash = createHash('sha256').update(buffer).digest('hex');
      const destPath = path.join(ATTACHMENTS_DIR, hash);

      if (!existsSync(destPath)) {
        writeFileSync(destPath, buffer);
      }

      const result = insert.run(
        Number(todoId), file.name, file.type || 'application/octet-stream',
        file.size, hash, now
      );

      attachments.push({
        id: Number(result.lastInsertRowid),
        todoId: Number(todoId),
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        hash,
      });
    }

    return NextResponse.json({ ok: true, attachments });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const url = request.nextUrl;
    const todoId = url.searchParams.get('todoId');
    if (!todoId) {
      return NextResponse.json({ error: 'todoId required' }, { status: 400 });
    }

    const db = getDb();
    const rows = db.prepare(
      'SELECT * FROM todo_attachments WHERE todo_id = ? ORDER BY created_at DESC'
    ).all(Number(todoId)) as any[];

    const attachments = rows.map((r) => ({
      id: r.id,
      todoId: r.todo_id,
      filename: r.filename,
      mimeType: r.mime_type,
      sizeBytes: r.size_bytes,
      hash: r.hash,
      createdAt: r.created_at,
    }));

    return NextResponse.json({ attachments });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const db = getDb();
    const body = await request.json();
    const { id } = body;
    if (!id) {
      return NextResponse.json({ error: 'id required' }, { status: 400 });
    }

    // Get the attachment to find its hash before deleting
    const attachment = db.prepare(
      'SELECT hash FROM todo_attachments WHERE id = ?'
    ).get(id) as any;

    if (!attachment) {
      return NextResponse.json({ error: 'attachment not found' }, { status: 404 });
    }

    const { hash } = attachment;

    // Delete the row
    db.prepare('DELETE FROM todo_attachments WHERE id = ?').run(id);

    // Check if any other rows reference this hash
    const remaining = db.prepare(
      'SELECT COUNT(*) as c FROM todo_attachments WHERE hash = ?'
    ).get(hash) as any;

    if (remaining.c === 0) {
      const filePath = path.join(ATTACHMENTS_DIR, hash);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
