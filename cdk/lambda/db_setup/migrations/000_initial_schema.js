exports.up = (pgm) => {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE EXTENSION IF NOT EXISTS "vector";

    -- ==============================
    -- ENUMS
    -- ==============================
    CREATE TYPE user_role AS ENUM ('student', 'admin');
    CREATE TYPE sender_role AS ENUM ('user', 'AI');
    CREATE TYPE data_source_type AS ENUM ('website', 'pdf', 'csv');
    CREATE TYPE ingestion_status AS ENUM ('running', 'failed', 'completed');
    CREATE TYPE system_message_type AS ENUM ('system_prompt', 'disclaimer');

    -- ==============================
    -- TABLES
    -- ==============================

    -- Users
    CREATE TABLE users (
      id uuid PRIMARY KEY,
      email varchar UNIQUE,
      display_name varchar,
      role user_role NOT NULL,
      created_at timestamptz DEFAULT now(),
      last_seen_at timestamptz,
      tokens_used bigint DEFAULT 0,
      token_window_started_at timestamptz NOT NULL DEFAULT now(),
      metadata jsonb DEFAULT '{}'
    );

    -- Data Sources (admin-managed)
    CREATE TABLE data_sources (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      display_name varchar(255) NOT NULL,
      actual_name varchar(255) NOT NULL,
      type data_source_type NOT NULL,
      created_by uuid,
      created_at timestamptz DEFAULT now(),
      metadata jsonb DEFAULT '{}'
    );

    -- Ingestion Runs (admin visibility)
    CREATE TABLE ingestion_runs (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      data_source_id uuid,
      status ingestion_status NOT NULL,
      error_message text,
      created_at timestamptz DEFAULT now(),
      completed_at timestamptz
    );

    -- Chat Sessions
    CREATE TABLE chat_sessions (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id uuid NOT NULL,
      title varchar,
      created_at timestamptz DEFAULT now(),
      last_active_at timestamptz,
      metadata jsonb DEFAULT '{}'
    );

    -- Chat Messages
    CREATE TABLE chat_messages (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      chat_session_id uuid NOT NULL,
      sender sender_role NOT NULL,
      content text NOT NULL,
      sources jsonb,
      created_at timestamptz DEFAULT now()
    );

    -- Session Feedback
    CREATE TABLE session_feedback (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      chat_session_id uuid NOT NULL,
      user_id uuid,
      rating int,
      comment text,
      created_at timestamptz DEFAULT now()
    );

    -- Analytics Events
    CREATE TABLE analytics_events (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      event_type varchar(128) NOT NULL,
      user_id uuid,
      chat_session_id uuid,
      properties jsonb DEFAULT '{}',
      created_at timestamptz DEFAULT now()
    );

    -- System Messages (allows rollback)
    CREATE TABLE system_messages (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      type system_message_type NOT NULL,
      content text NOT NULL,
      version int NOT NULL,
      is_active boolean NOT NULL DEFAULT false,
      created_by uuid,
      created_at timestamptz DEFAULT now()
    );

    -- System Settings
    CREATE TABLE system_settings (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      max_messages_per_session int,
      min_messages_before_suggest int,
      num_specializations_to_suggest int,
      max_characters_per_user_message int,
      max_characters_per_ai_message int,
      welcome_message text,
      updated_by uuid,
      updated_at timestamptz DEFAULT now()
    );

    -- ==============================
    -- INDEXES
    -- ==============================
    CREATE INDEX idx_chat_sessions_user_id ON chat_sessions(user_id);
    CREATE INDEX idx_chat_messages_chat_session_id ON chat_messages(chat_session_id);
    CREATE INDEX idx_analytics_events_user_id ON analytics_events(user_id);
    CREATE INDEX idx_analytics_events_chat_session_id ON analytics_events(chat_session_id);
    CREATE INDEX idx_ingestion_runs_data_source_id ON ingestion_runs(data_source_id);

    -- ==============================
    -- FOREIGN KEY CONSTRAINTS
    -- ==============================
    ALTER TABLE data_sources ADD CONSTRAINT fk_data_sources_created_by FOREIGN KEY (created_by) REFERENCES users(id);
    ALTER TABLE ingestion_runs ADD CONSTRAINT fk_ingestion_runs_data_source_id FOREIGN KEY (data_source_id) REFERENCES data_sources(id);
    ALTER TABLE chat_sessions ADD CONSTRAINT fk_chat_sessions_user_id FOREIGN KEY (user_id) REFERENCES users(id);
    ALTER TABLE chat_messages ADD CONSTRAINT fk_chat_messages_chat_session_id FOREIGN KEY (chat_session_id) REFERENCES chat_sessions(id);
    ALTER TABLE session_feedback ADD CONSTRAINT fk_session_feedback_chat_session_id FOREIGN KEY (chat_session_id) REFERENCES chat_sessions(id);
    ALTER TABLE session_feedback ADD CONSTRAINT fk_session_feedback_user_id FOREIGN KEY (user_id) REFERENCES users(id);
    ALTER TABLE analytics_events ADD CONSTRAINT fk_analytics_events_user_id FOREIGN KEY (user_id) REFERENCES users(id);
    ALTER TABLE analytics_events ADD CONSTRAINT fk_analytics_events_chat_session_id FOREIGN KEY (chat_session_id) REFERENCES chat_sessions(id);
    ALTER TABLE system_messages ADD CONSTRAINT fk_system_messages_created_by FOREIGN KEY (created_by) REFERENCES users(id);
    ALTER TABLE system_settings ADD CONSTRAINT fk_system_settings_updated_by FOREIGN KEY (updated_by) REFERENCES users(id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS analytics_events CASCADE;
    DROP TABLE IF EXISTS session_feedback CASCADE;
    DROP TABLE IF EXISTS chat_messages CASCADE;
    DROP TABLE IF EXISTS chat_sessions CASCADE;
    DROP TABLE IF EXISTS system_settings CASCADE;
    DROP TABLE IF EXISTS system_messages CASCADE;
    DROP TABLE IF EXISTS ingestion_runs CASCADE;
    DROP TABLE IF EXISTS data_sources CASCADE;
    DROP TABLE IF EXISTS users CASCADE;

    DROP TYPE IF EXISTS system_message_type;
    DROP TYPE IF EXISTS ingestion_status;
    DROP TYPE IF EXISTS data_source_type;
    DROP TYPE IF EXISTS sender_role;
    DROP TYPE IF EXISTS user_role;
  `);
};