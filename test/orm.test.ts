import { expect, test } from 'bun:test'
import { eventEntityMapping } from '#/infrastructure/event-entity.ts'
import { reservationEntityMapping } from '#/infrastructure/reservation-entity.ts'
import {
  insertStatement,
  selectStatement,
  sumStatement,
  updateStatement,
} from '#/infrastructure/orm.ts'
import type { EntityMapping } from '#/infrastructure/orm.ts'

test('ORM select keeps filters parameterized and supports ordering and locks', () => {
  const after = new Date('2030-01-01T00:00:00Z')
  const statement = selectStatement(eventEntityMapping, {
    where: [
      { column: 'category', operator: '=', value: 'gaming' },
      { column: 'starts_at', operator: '>', value: after },
    ],
    orderBy: ['starts_at', 'id'],
    forUpdate: true,
  })

  expect(statement.text).toBe(
    'SELECT "id", "title", "category", "starts_at", "capacity", "venue_id" FROM "events" WHERE "category" = $1 AND "starts_at" > $2 ORDER BY "starts_at", "id" FOR UPDATE',
  )
  expect(statement.parameters).toEqual(['gaming', after])
  expect(statement.text).not.toContain('gaming')
})

test('ORM insert and update bind data values separately from SQL', () => {
  const insert = insertStatement(eventEntityMapping, {
    id: 'event-id',
    title: "Today's event",
    category: 'gaming',
    starts_at: new Date('2030-01-01T00:00:00Z'),
    capacity: 12,
    venue_id: 'venue-id',
  })
  expect(insert.text).toBe(
    'INSERT INTO "events" ("id", "title", "category", "starts_at", "capacity", "venue_id") VALUES ($1, $2, $3, $4, $5, $6)',
  )
  expect(insert.parameters).toEqual([
    'event-id',
    "Today's event",
    'gaming',
    new Date('2030-01-01T00:00:00Z'),
    12,
    'venue-id',
  ])
  expect(insert.text).not.toContain("Today's event")

  const update = updateStatement(eventEntityMapping, { title: 'Updated' }, [
    { column: 'id', operator: '=', value: 'event-id' },
  ])
  expect(update.text).toBe('UPDATE "events" SET "title" = $1 WHERE "id" = $2')
  expect(update.parameters).toEqual(['Updated', 'event-id'])
})

test('ORM sum supports null filters and refuses unbounded updates', () => {
  const statement = sumStatement(reservationEntityMapping, 'quantity', [
    { column: 'event_id', operator: '=', value: 'event-id' },
    { column: 'cancelled_at', operator: 'IS NULL' },
  ])
  expect(statement.text).toBe(
    'SELECT COALESCE(SUM("quantity"), 0)::int AS "total" FROM "reservations" WHERE "event_id" = $1 AND "cancelled_at" IS NULL',
  )
  expect(statement.parameters).toEqual(['event-id'])
  expect(() =>
    updateStatement(eventEntityMapping, { title: 'Updated' }, []),
  ).toThrow('ORM updates require at least one condition')
  const unsafeMapping: EntityMapping<{ id: string }> = {
    table: 'events; DROP TABLE users',
    columns: ['id'],
  }
  expect(() =>
    selectStatement(unsafeMapping, {
      where: [{ column: 'id', operator: '=', value: 'event-id' }],
    }),
  ).toThrow('Invalid ORM identifier')
})
