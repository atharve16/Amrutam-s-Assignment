import { Matches } from 'class-validator';

const OFFSET_TIMESTAMP = /(?:Z|[+-]\d{2}:\d{2})$/;

export class AnalyticsQueryDto {
  @Matches(OFFSET_TIMESTAMP, { message: 'from must include Z or an explicit UTC offset' })
  from!: string;

  @Matches(OFFSET_TIMESTAMP, { message: 'to must include Z or an explicit UTC offset' })
  to!: string;
}
