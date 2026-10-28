import { SQL } from 'bun'
import type {
  ApplicationError,
  EventFilter,
  EventRepository,
} from '#/application/ports.ts'
import type { Event } from '#/domain/event.ts'
import type { Reservation } from '#/domain/reservation.ts'
import type { EventId, ReservationId, UserId } from '#/domain/ids.ts'
import { InvalidInput, NotFound } from '#/domain/errors.ts'
import { Option } from '#/shared-kernel/option.ts'
import { Result } from '#/shared-kernel/result.ts'
import {
  eventToDomain,
  eventToEntity,
  eventEntityMapping,
  type EventEntity,
} from '#/infrastructure/event-entity.ts'
import {
  reservationFromRow,
  reservationToEntity,
  reservationEntityMapping,
} from '#/infrastructure/reservation-entity.ts'
import {
  Orm,
  type EntityMapping,
  type OrmCondition,
} from '#/infrastructure/orm.ts'

const userEntityMapping: EntityMapping<{ id: string }> = {
  table: 'users',
  columns: ['id'],
}

export class PostgresEventRepository implements EventRepository {
  private readonly orm: Orm

  constructor(private readonly sql: SQL) {
    this.orm = new Orm(sql)
  }

  async listEvents(filter: EventFilter) {
    const where: OrmCondition<EventEntity>[] = []
    if (filter.category !== undefined) {
      where.push({
        column: 'category',
        operator: '=',
        value: filter.category,
      })
    }
    if (filter.after !== undefined) {
      where.push({ column: 'starts_at', operator: '>', value: filter.after })
    }
    const rows = await this.orm.select(eventEntityMapping, {
      where,
      orderBy: ['starts_at', 'id'],
    })
    return rows.map(eventToDomain)
  }

  async findEvent(id: EventId): Promise<Option<Event>> {
    const rows = await this.orm.select(eventEntityMapping, {
      where: [{ column: 'id', operator: '=', value: id }],
    })
    return Option.map(Option.fromNullable(rows[0]), eventToDomain)
  }

  async createEvent(event: Event): Promise<Result<Event, ApplicationError>> {
    const entity = eventToEntity(event)
    return this.write(async () => {
      await this.orm.insert(eventEntityMapping, entity)
      return Result.succeed(event)
    })
  }

  async updateEvent(
    id: EventId,
    change: (
      event: Event,
      reservedSeats: number,
    ) => Result<Event, ApplicationError>,
  ): Promise<Result<Event, ApplicationError>> {
    return this.write(() =>
      this.sql.begin(async (tx) => {
        const orm = new Orm(tx)
        const found = await this.lockEvent(orm, id)
        if (Option.isNone(found)) {
          return Result.fail(new NotFound('Event not found'))
        }
        const updated = change(found.value, await this.reservedSeats(orm, id))
        if (updated._tag === 'Failure') {
          return updated
        }
        const entity = eventToEntity(updated.value)
        await orm.update(
          eventEntityMapping,
          {
            title: entity.title,
            category: entity.category,
            starts_at: entity.starts_at,
            capacity: entity.capacity,
            venue_id: entity.venue_id,
          },
          [{ column: 'id', operator: '=', value: id }],
        )
        return updated
      }),
    )
  }

  async reserve(
    eventId: EventId,
    create: (
      event: Event,
      reservedSeats: number,
    ) => Result<Reservation, ApplicationError>,
  ): Promise<Result<Reservation, ApplicationError>> {
    return this.write(() =>
      this.sql.begin(async (tx) => {
        const orm = new Orm(tx)
        const found = await this.lockEvent(orm, eventId)
        if (Option.isNone(found)) {
          return Result.fail(new NotFound('Event not found'))
        }
        const result = create(
          found.value,
          await this.reservedSeats(orm, eventId),
        )
        if (result._tag === 'Failure') {
          return result
        }
        const d = reservationToEntity(result.value)
        await orm.insert(reservationEntityMapping, {
          id: d.id,
          event_id: d.event_id,
          user_id: d.user_id,
          quantity: d.quantity,
          created_at: d.created_at,
        })
        return result
      }),
    )
  }

  async listReservations(userId: UserId) {
    const rows = await this.orm.select(reservationEntityMapping, {
      where: [{ column: 'user_id', operator: '=', value: userId }],
      orderBy: ['created_at', 'id'],
    })
    return rows.map(reservationFromRow)
  }

  async cancelReservation(
    id: ReservationId,
    userId: UserId,
    change: (reservation: Reservation) => Result<Reservation, ApplicationError>,
  ): Promise<Result<Reservation, ApplicationError>> {
    return this.sql.begin(async (tx) => {
      const orm = new Orm(tx)
      const rows = await orm.select(reservationEntityMapping, {
        where: [
          { column: 'id', operator: '=', value: id },
          { column: 'user_id', operator: '=', value: userId },
        ],
        forUpdate: true,
      })
      const found = Option.fromNullable(rows[0])
      if (Option.isNone(found)) {
        return Result.fail(new NotFound('Reservation not found'))
      }
      const updated = change(reservationFromRow(found.value))
      if (updated._tag === 'Failure') {
        return updated
      }
      const entity = reservationToEntity(updated.value)
      await orm.update(
        reservationEntityMapping,
        { cancelled_at: entity.cancelled_at },
        [{ column: 'id', operator: '=', value: id }],
      )
      return updated
    })
  }

  async userExists(id: UserId) {
    const rows = await this.orm.select(userEntityMapping, {
      where: [{ column: 'id', operator: '=', value: id }],
    })
    return rows.length > 0
  }

  private async lockEvent(orm: Orm, id: EventId): Promise<Option<Event>> {
    const rows = await orm.select(eventEntityMapping, {
      where: [{ column: 'id', operator: '=', value: id }],
      forUpdate: true,
    })
    return Option.map(Option.fromNullable(rows[0]), eventToDomain)
  }

  private reservedSeats(orm: Orm, eventId: EventId): Promise<number> {
    return orm.sum(reservationEntityMapping, 'quantity', [
      { column: 'event_id', operator: '=', value: eventId },
      { column: 'cancelled_at', operator: 'IS NULL' },
    ])
  }

  private async write<Value>(
    operation: () => Promise<Result<Value, ApplicationError>>,
  ): Promise<Result<Value, ApplicationError>> {
    const result = await Result.tryPromise(operation, (cause) => {
      if (cause instanceof SQL.PostgresError && cause.code === '23503') {
        return new InvalidInput('Referenced venue or user does not exist')
      }
      // Lost connections, corrupt SQL and driver faults are not business failures.
      throw cause
    })
    return result._tag === 'Failure' ? result : result.value
  }
}
