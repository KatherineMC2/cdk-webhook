import type { Handler } from 'aws-lambda';
import { userSchema } from './schema/user';

export const handler: Handler = async (event) => {
  const body = JSON.parse(event.body);
  const result = userSchema.safeParse(body);
  if (!result.success) {
    const errors = result.error.errors.map((err) => ({
      path: err.path.join('.'),
      message: err.message,
    }));

    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: 'Validation failed',
        errors: errors,
      }),
    };
  }
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'hellou, hellou',
    }),
    headers: {
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
    },
  };
};
